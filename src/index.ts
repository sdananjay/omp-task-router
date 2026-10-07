import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { classify } from "./classifier";
import { DEFAULT_CONFIG, loadConfig } from "./config";
import { Router } from "./router";
import type { ClassifyFn } from "./router";
import { registerUi } from "./ui";

interface StashedText {
	name: string | undefined;
	task: string | undefined;
	solutionSpace: string | undefined;
	effort: string | undefined;
}

export default function taskRouterExtension(pi: ExtensionAPI): void {
	// Fail-open wrapper: session state lives in the factory closure; a throw
	// anywhere in our handlers must never break the spawn.
	let router: Router | undefined;
	const pending = new Map<string, Map<number, { text: StashedText; spawnKey?: string }>>();

	function ensureRouter(classifyFn: ClassifyFn): Router {
		router ??= new Router(DEFAULT_CONFIG, classifyFn);
		router.setClassifier(classifyFn);
		return router;
	}

	function capture(toolCallId: string, raw: unknown): void {
		pending.delete(toolCallId);
		if (!raw || typeof raw !== "object") return;
		const input = raw as Record<string, unknown>;
		const items = Array.isArray(input.tasks) ? input.tasks : [input];
		const entries = new Map<number, { text: StashedText; spawnKey?: string }>();
		items.forEach((rawItem, index) => {
			if (!rawItem || typeof rawItem !== "object") return;
			const item = rawItem as Record<string, unknown>;
			entries.set(index, { text: {
				name: typeof item.name === "string" ? item.name.trim() : undefined,
				task: typeof item.task === "string" ? item.task : undefined,
				solutionSpace: typeof item.solutionSpace === "string" ? item.solutionSpace : undefined,
				effort: typeof item.effort === "string" ? item.effort : undefined,
			} });
		});
		if (entries.size) pending.set(toolCallId, entries);
	}

	// OMP progress rows bind an allocated agent id to the original call/index.
	function bindProgress(toolCallId: string, raw: unknown, settled = false): void {
		const entries = pending.get(toolCallId);
		if (!entries) return;
		const details = (raw as { details?: { progress?: { index: number; id: string; status: string }[]; async?: { state: string } } } | undefined)?.details;
		const queued = new Set<number>();
		for (const row of details?.progress ?? []) {
			if (typeof row.id !== "string" || !Number.isInteger(row.index)) continue;
			if (row.status !== "pending" && row.status !== "running") {
				entries.delete(row.index);
				continue;
			}
			const entry = entries.get(row.index);
			if (entry) entry.spawnKey = row.id;
			if (details?.async?.state === "running") queued.add(row.index);
		}
		// A returned background call may still have children waiting for a permit.
		if (settled) for (const index of entries.keys()) if (!queued.has(index)) entries.delete(index);
		if (!entries.size) pending.delete(toolCallId);
	}

	pi.on("tool_call", event => {
		if (event.toolName === "task") capture(event.toolCallId, event.input);
	});
	pi.on("tool_execution_start", event => {
		if (event.toolName === "task") capture(event.toolCallId, event.args);
	});
	pi.on("tool_execution_update", event => {
		if (event.toolName === "task") bindProgress(event.toolCallId, event.partialResult);
	});
	pi.on("tool_result", event => {
		if (event.toolName !== "task") return;
		if (event.isError) pending.delete(event.toolCallId);
		else bindProgress(event.toolCallId, event, true);
	});
	pi.on("tool_execution_end", event => {
		if (event.toolName !== "task") return;
		if (event.isError) pending.delete(event.toolCallId);
		else bindProgress(event.toolCallId, event.result, true);
	});
	pi.on("tool_approval_resolved", event => {
		if (event.toolName === "task" && !event.approved) pending.delete(event.toolCallId);
	});
	pi.on("turn_end", () => {
		for (const [id, entries] of pending) {
			for (const [index, entry] of entries) if (!entry.spawnKey) entries.delete(index);
			if (!entries.size) pending.delete(id);
		}
	});
	pi.on("session_switch", () => pending.clear());
	pi.on("session_shutdown", () => pending.clear());

	pi.on("before_subagent_spawn", async (event, ctx) => {
		try {
			if (event.invocationKind !== "task" || !event.spawnKey) return undefined;
			let match: { callId: string; index: number; text: StashedText } | undefined;
			for (const [callId, entries] of pending) {
				for (const [index, entry] of entries) {
					// A caller-supplied label can itself look like another call:index.
					if (!entry.spawnKey && entry.text.name === event.spawnKey && event.spawnKey !== `${callId}:${index}`) return undefined;
					if (event.spawnKey !== (entry.spawnKey ?? `${callId}:${index}`)) continue;
					if (match) return undefined; // ambiguous key: never guess
					match = { callId, index, text: entry.text };
				}
			}
			const text = match?.text;
			if (match) {
				const entries = pending.get(match.callId)!;
				entries.delete(match.index);
				if (!entries.size) pending.delete(match.callId);
			}
			// ponytail: names/opaque keys without progress cannot identify a call;
			// leave untouched until OMP exposes parentToolCallId + index in this event.

			if (!text || (text.task === undefined && text.solutionSpace === undefined)) {
				return undefined; // eval agents, speculative launches, no text — leave untouched
			}

			// Consume before the first await: cleanup or another hook cannot steal it.
			const { config } = await loadConfig();
			const classifyFn: ClassifyFn = async (input, cfg, signal) =>
				classify({ task: input.task, solutionSpace: input.solutionSpace }, ctx, cfg, Object.keys(cfg.tiers), signal);
			const active = ensureRouter(classifyFn);
			active.reload(config);
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

}