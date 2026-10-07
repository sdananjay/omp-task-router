import type { RouterConfig, TierMap } from "./config";
import { preview } from "./config";

export interface RoutingDecision {
	timestamp: number;
	taskPreview: string;
	solutionSpacePreview: string;
	classifierModel: string;
	classifierTier: string | undefined;
	classifierReason: string | undefined;
	selectedTier: string;
	mappedModel: string;
	modelRole: string | undefined;
	patterns: string[];
	effort: string | undefined;
	classificationLatencyMs: number;
	outcome: RoutingOutcome;
	fallbackReason: string | undefined;
}

export type RoutingOutcome =
	| "routed"
	| "router_disabled"
	| "explicit_model_preserved"
	| "classifier_failed"
	| "classifier_timeout"
	| "invalid_classifier_output"
	| "unknown_tier"
	| "default_tier_used"
	| "no_mapping"
	| "task_left_unchanged";

export interface RoutingInput {
	task: string | undefined;
	solutionSpace: string | undefined;
	agent: string;
	invocationKind: "task" | "eval";
	modelRole: string | undefined;
	patterns: string[];
	effort: string | undefined;
}

export interface RoutingVerdict {
	/** Return {model, note} to remap the spawn; undefined leaves OMP untouched. */
	result: { model?: string | string[]; note?: string } | undefined;
	decision: RoutingDecision;
}

const HISTORY_MAX = 200;

/** Router state per OMP session (keyed by session id). */
export class Router {
	readonly history: RoutingDecision[] = [];
	private readonly cache = new Map<string, ClassifiedTier>();
	#config: RouterConfig;
	#classify: ClassifyFn;

	constructor(config: RouterConfig, classify: ClassifyFn) {
		this.#config = config;
		this.#classify = classify;
	}

	get config(): RouterConfig {
		return this.#config;
	}

	reload(config: RouterConfig): void {
		const previous = this.#config;
		this.#config = config;
		// Classification-relevant inputs unchanged → keep warm cache entries.
		if (
			previous.classifier.model === config.classifier.model &&
			previous.classifier.prompt === config.classifier.prompt &&
			JSON.stringify(Object.keys(previous.tiers)) === JSON.stringify(Object.keys(config.tiers))
		) {
			return;
		}
		this.cache.clear();
	}

	/** Swap the classify fn (ctx changes per spawn event). */
	setClassifier(classify: ClassifyFn): void {
		this.#classify = classify;
	}

	record(decision: RoutingDecision): void {
		this.history.push(decision);
		if (this.history.length > HISTORY_MAX) this.history.shift();
	}

	recent(count: number, sessionId: string | undefined): RoutingDecision[] {
		// The Router instance is per session (the factory rebinds per session);
		// sessionId is informational parity with ctx.sessionManager and not used for keying.
		void sessionId;
		return this.history.slice(-count);
	}

	/**
	 * Route one spawn. Never throws; never blocks. undefined result = leave OMP alone.
	 */
	async route(input: RoutingInput, signal: AbortSignal | undefined): Promise<RoutingVerdict> {
		const decision: RoutingDecision = {
			timestamp: Date.now(),
			taskPreview: preview(input.task),
			solutionSpacePreview: preview(input.solutionSpace),
			classifierModel: this.#config.classifier.model,
			classifierTier: undefined,
			classifierReason: undefined,
			selectedTier: this.#config.defaultTier,
			mappedModel: "",
			modelRole: input.modelRole,
			patterns: input.patterns,
			effort: input.effort,
			classificationLatencyMs: 0,
			outcome: "task_left_unchanged",
			fallbackReason: undefined,
		};

		try {
			if (!this.#config.enabled) {
				decision.outcome = "router_disabled";
				return { result: undefined, decision };
			}

			if (input.effort !== undefined) {
				// Record effort for observability only — never rewritten.
				decision.effort = input.effort;
			}

			const tiers = this.#config.tiers;
			if (isExplicitModelPolicyPreserved(this.#config, input.modelRole, tiers)) {
				decision.outcome = "explicit_model_preserved";
				return { result: undefined, decision };
			}

			const classified = await this.#classifyWithCache(input, signal, decision);
			if (classified === undefined) {
				// decision.outcome already set by classifier failure path — fail open
				// through defaultTier when IT maps, else leave OMP untouched.
				const fallback = tiers[this.#config.defaultTier];
				if (!fallback) return { result: undefined, decision };
				decision.selectedTier = this.#config.defaultTier;
				decision.mappedModel = fallback.model;
				return {
					result: { model: fallback.model, note: `task-router: fallback tier=${decision.selectedTier} (${decision.fallbackReason ?? decision.outcome})` },
					decision,
				};
			}
			decision.classifierTier = classified.tier;
			decision.classifierReason = classified.reason;

			const tierId = this.#selectTier(classified, decision);
			decision.selectedTier = tierId;
			decision.mappedModel = tiers[tierId]?.model ?? "";
			if (!tiers[tierId]) {
				decision.outcome = "no_mapping";
				decision.fallbackReason = `tier "${tierId}" has no configured model`;
				return { result: undefined, decision };
			}

			if (tierId !== classified.tier) decision.outcome = classified.tier === undefined ? "classifier_failed" : "unknown_tier";
			else decision.outcome = "routed";
			decision.fallbackReason =
				outcomeFallbackReason(decision.outcome) ?? undefined;

			return {
				result: { model: tiers[tierId].model, note: `task-router: tier=${tierId}${classified.reason ? ` (${classified.reason})` : ""}` },
				decision,
			};
		} catch (err) {
			decision.outcome = "classifier_failed";
			decision.fallbackReason = err instanceof Error ? err.message : String(err);
			return { result: undefined, decision };
		} finally {
			this.record(decision);
		}
	}

	async #classifyWithCache(
		input: RoutingInput,
		signal: AbortSignal | undefined,
		decision: RoutingDecision,
	): Promise<ClassifiedTier | undefined> {
		const config = this.#config;
		const cacheKey = config.classifier.cache ? cacheKeyFor(input, config) : undefined;
		if (cacheKey) {
			const hit = this.cache.get(cacheKey);
			if (hit) {
				decision.classificationLatencyMs = 0;
				return hit;
			}
		}
		const start = performance.now();
		try {
			const classified = await this.#classify(input, config, signal);
			decision.classificationLatencyMs = Math.round(performance.now() - start);
			if (classified === undefined) {
				decision.outcome = "classifier_failed";
				decision.fallbackReason ??= "classifier returned no usable output";
				return undefined;
			}
			if (cacheKey) {
				this.cache.set(cacheKey, classified);
				if (this.cache.size > 256) {
					const first = this.cache.keys().next().value;
					if (first !== undefined) this.cache.delete(first);
				}
			}
			return classified;
		} catch (err) {
			decision.classificationLatencyMs = Math.round(performance.now() - start);
			if (isTimeoutError(err)) {
				decision.outcome = "classifier_timeout";
			} else {
				decision.outcome = "classifier_failed";
			}
			decision.fallbackReason = err instanceof Error ? err.message : String(err);
			return undefined;
		}
	}

	#selectTier(classified: ClassifiedTier, decision: RoutingDecision): string {
		const cfg = this.#config;
		if (classified.tier === undefined) {
			decision.outcome = "classifier_failed";
			decision.fallbackReason ??= "no tier parsed";
			return cfg.tiers[cfg.defaultTier] ? cfg.defaultTier : Object.keys(cfg.tiers)[0] ?? "";
		}
		if (!cfg.tiers[classified.tier]) {
			decision.outcome = "unknown_tier";
			decision.fallbackReason = `classifier returned unknown tier "${classified.tier}"`;
			return cfg.tiers[cfg.defaultTier] ? cfg.defaultTier : Object.keys(cfg.tiers)[0] ?? "";
		}
		if (classified.tier === cfg.defaultTier) return classified.tier;
		return classified.tier;
	}
}

/** Explicit model selection wins unless disabled — mirrors config.respectExplicitModel. */
function isExplicitModelPolicyPreserved(
	config: RouterConfig,
	modelRole: string | undefined,
	tiers: TierMap,
): boolean {
	if (!config.respectExplicitModel) return false;
	// Per BeforeSubagentSpawnEvent docs: `modelRole` is "undefined for explicit
	// selectors" — a concrete model id or explicit pattern was requested.
	if (modelRole === undefined) return true;
	// Inherited generic-task defaults are ours to route; any other role alias is an explicit choice.
	if (modelRole === "default" || modelRole === "task") {
		return false;
	}
	return !Object.keys(tiers).some(id => modelRole === id);
}

function outcomeFallbackReason(outcome: RoutingOutcome): string | undefined {
	return outcome === "routed" || outcome === "default_tier_used" ? undefined : outcome;
}

function isTimeoutError(err: unknown): boolean {
	return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

export interface ClassifiedTier {
	/** undefined when parsing failed entirely. */
	tier: string | undefined;
	reason: string | undefined;
}

export type ClassifyFn = (
	input: RoutingInput,
	config: RouterConfig,
	signal: AbortSignal | undefined,
) => Promise<ClassifiedTier | undefined>;

function cacheKeyFor(input: RoutingInput, config: RouterConfig): string {
	return JSON.stringify([input.task ?? "", input.solutionSpace ?? "", config.classifier.model, config.classifier.prompt, Object.keys(config.tiers)]);
}