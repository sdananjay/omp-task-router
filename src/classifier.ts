import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ClassifiedTier } from "./router";

/** Parse classifier output: bare word, JSON object, or fenced JSON. */
export function parseClassifierOutput(raw: string | undefined, tierIds: readonly string[]): ClassifiedTier {
	if (!raw) return { tier: undefined, reason: undefined };
	let text = raw.trim();
	// strip markdown fences if present
	const fence = /^```[a-z]*\n([\s\S]*?)\n```$/m.exec(text);
	if (fence?.[1]) text = fence[1].trim();
	// whole-text JSON first (covers pretty-printed multiline objects)
	const whole = tryParseJsonTier(text, tierIds);
	if (whole) return whole;
	// then single-line JSON candidates (JSON with leading prose, etc.)
	const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line: string | undefined = lines[i];
		if (line === undefined) continue;
		if (line.startsWith("{") && line.endsWith("}")) {
			const parsedLine = tryParseJsonTier(line, tierIds);
			if (parsedLine) return parsedLine;
		}
	}
	// bare word: first line, first token
	const first = lines[0];
	const word = first?.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9_-]/g, "");
	if (word) return { tier: normalizeTier(word, tierIds), reason: undefined };
	return { tier: undefined, reason: undefined };
}

/** Parse `{"tier": ..., "reason": ...}`; undefined when not a valid tier object. */
function tryParseJsonTier(text: string, tierIds: readonly string[]): ClassifiedTier | undefined {
	if (!text.startsWith("{")) return undefined;
	try {
		const parsed = JSON.parse(text) as { tier?: unknown; reason?: unknown };
		if (typeof parsed.tier === "string") {
			return {
				tier: normalizeTier(parsed.tier, tierIds),
				reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
			};
		}
	} catch {
		// not JSON
	}
	return undefined;
}

/** Match a tier id case-insensitively/partially against the configured list. */
function normalizeTier(candidate: string, tierIds: readonly string[]): string | undefined {
	const direct = tierIds.find(id => id === candidate);
	if (direct) return direct;
	const lower = tierIds.find(id => id.toLowerCase() === candidate.toLowerCase());
	if (lower) return lower;
	return undefined;
}

/**
 * Classify with OMP's own model machinery: completeSimple against the
 * configured classifier model, reasoning disabled (utility call), tiny budget.
 * Any failure throws — the router catches and fails open.
 */
export async function classify(
	input: { task?: string; solutionSpace?: string },
	ctx: ExtensionContext,
	config: { classifier: { model: string; prompt: string; timeoutMs: number } },
	tierIds: readonly string[],
	signal: AbortSignal | undefined,
): Promise<ClassifiedTier> {
	if (!input.task && !input.solutionSpace) return { tier: undefined, reason: undefined };
	const model = ctx.models.resolve(config.classifier.model);
	if (!model) {
		throw new Error(`classifier model "${config.classifier.model}" did not resolve`);
	}

	const prompt = config.classifier.prompt.replace(
		"{tiers}",
		tierIds.map(id => `- ${id}`).join("\n"),
	);
	const userContent = [
		input.task ? `Task:\n${input.task}` : undefined,
		input.solutionSpace ? `Solution space:\n${input.solutionSpace}` : undefined,
	]
		.filter(Boolean)
		.join("\n\n");

	const timeout = AbortSignal.timeout(config.classifier.timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const sessionId = ctx.sessionManager.getSessionId();
	const message = await completeSimple(
		model,
		{
			systemPrompt: [prompt],
			messages: [{ role: "user" as const, content: userContent, timestamp: Date.now() }],
		},
		{
			apiKey: ctx.modelRegistry.resolver(model, sessionId),
			disableReasoning: true,
			maxTokens: 256,
			signal: requestSignal,
		},
	);
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(`classifier request failed: ${message.stopReason}`);
	}
	const text = message.content
		.filter((part: { type: string; text?: string }): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map(part => part.text)
		.join("");
	const parsed = parseClassifierOutput(text, tierIds);
	if (parsed.tier === undefined) {
		throw new Error(`invalid classifier output: ${text.slice(0, 120)}`);
	}
	return parsed;
}