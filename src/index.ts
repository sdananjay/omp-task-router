import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { classify } from "./classifier";
import { DEFAULT_PROMPT, DEFAULT_TIERS, loadConfig, preview } from "./config";
import type { RouterConfig } from "./config";
import { Router } from "./router";
import type { ClassifyFn, RoutingInput } from "./router";
import { registerUi } from "./ui";

interface StashedText {
	task: string | undefined;
	solutionSpace: string | undefined;
	effort: string | undefined;
}

/** Failsafe config used until loadConfig() succeeds; identical to defaults. */
const FALLBACK_CONFIG: RouterConfig = {
	enabled: true,
	classifier: { model: "@tiny", prompt: DEFAULT_PROMPT, timeoutMs: 8000, cache: true },
	defaultTier: "normal",
	respectExplicitModel: true,
	tiers: DEFAULT_TIERS,
};

export default function taskRouterExtension(pi: ExtensionAPI): void {
	// Fail-open wrapper: session state lives in the factory closure; a throw
	// anywhere in our handlers must never break the spawn.
	let router: Router | undefined;
	let liveCtx: ExtensionContext | undefined;
	/**
	 * Pending task texts in tool_call emission order. Spawns dispatch
	 * sequentially per task call and calls dispatch in order, so spawn N pairs
	 * with queue entry N (batch items pushed in item order). Each entry carries
	 * its toolCallId so a later tool_call with the same id (streaming partial →
	 * final) REPLACES its earlier entry instead of duplicating it.
	 */
	const pending: Array<{ toolCallId: string; text: StashedText }> = [];

	function ensureRouter(classifyFn: ClassifyFn): Router {
		router ??= new Router(FALLBACK_CONFIG, classifyFn);
		router.setClassifier(classifyFn);
		return router;
	}

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (event.toolName !== "task") return undefined;
			liveCtx = ctx;
			const input = event.input as Record<string, unknown> | undefined;
			if (!input) return undefined;
			const effortOf = (raw: unknown): string | undefined => (typeof raw === "string" ? raw : undefined);
			const readText = (item: Record<string, unknown>): StashedText => ({
				task: typeof item.task === "string" ? item.task : undefined,
				solutionSpace: typeof item.solutionSpace === "string" ? item.solutionSpace : undefined,
				effort: effortOf(item.effort),
			});
			let texts: StashedText[];
			if (Array.isArray(input.tasks)) {
				texts = (input.tasks as unknown[]).map(item =>
					item && typeof item === "object" && "task" in item ? readText(item as Record<string, unknown>) : { task: undefined, solutionSpace: undefined, effort: undefined },
				);
			} else {
				texts = [readText(input)];
			}
			// Streaming partial events replace this call's entries; a later call appends.
			const kept = pending.filter(entry => entry.toolCallId !== event.toolCallId);
			pending.length = 0;
			pending.push(...kept, ...texts.map(text => ({ toolCallId: event.toolCallId, text })));
			// Keep the raw input untouched — classification happens on the spawn hook.
			return undefined;
		} catch {
			return undefined;
		}
	});

	pi.on("before_subagent_spawn", async (event, ctx) => {
		try {
			liveCtx = ctx;
			const { config } = await loadConfig();
			const classifyFn: ClassifyFn = async (input, cfg, signal) =>
				classify({ task: input.task, solutionSpace: input.solutionSpace }, ctx, cfg, Object.keys(cfg.tiers), signal);
			const active = ensureRouter(classifyFn);
			active.reload(config, active.config);

			// Pair spawn with stashed text: FIFO in emission order (see pending docs).
			let text: StashedText | undefined;
			if (event.invocationKind === "task" && pending.length > 0) {
				text = pending.shift()!.text;
			}

			if (!text || (text.task === undefined && text.solutionSpace === undefined)) {
				return undefined; // eval agents, speculative launches, no text — leave untouched
			}

			const verdict = await active.route(
				{
					task: text.task,
					solutionSpace: text.solutionSpace,
					agent: event.agent,
					invocationKind: event.invocationKind,
					modelRole: event.modelRole,
					patterns: event.patterns ?? [],
					effort: text.effort,
				},
				undefined,
			);
			// OMP passes unresolvable `@alias` values through as literal patterns that
			// match no model — validate before handing the spawn over, else fail open.
			const target = typeof verdict.result?.model === "string" ? verdict.result.model : undefined;
			if (target && ctx.models.resolve(target) === undefined) {
				verdict.decision.outcome = "no_mapping";
				verdict.decision.fallbackReason = `tier model "${target}" does not resolve to a model or configured role`;
				return undefined;
			}
			// Observability: one debug line per decision; full history via /task-router history.
			pi.logger.debug("task-router: decision", {
				outcome: verdict.decision.outcome,
				tier: verdict.decision.selectedTier,
				mappedModel: verdict.decision.mappedModel,
				reason: verdict.decision.classifierReason,
				fallbackReason: verdict.decision.fallbackReason,
				modelRole: verdict.decision.modelRole,
				effort: verdict.decision.effort,
				latencyMs: verdict.decision.classificationLatencyMs,
			});
			return verdict.result ?? undefined;
		} catch {
			return undefined;
		}
	});

	// UI reads router state per session.
	registerUi(pi, () => router, () => undefined);

	// preview re-exported for tests below.
	void preview;
}

// Re-exported for tests.
export { DEFAULT_PROMPT, DEFAULT_TIERS, FALLBACK_CONFIG, preview };