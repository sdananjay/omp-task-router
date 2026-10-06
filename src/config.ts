import { mkdir } from "node:fs/promises";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export type TierMap = Record<string, { model: string }>;

export interface ClassifierConfig {
	model: string;
	prompt: string;
	timeoutMs: number;
	cache: boolean;
}

export interface RouterConfig {
	enabled: boolean;
	classifier: ClassifierConfig;
	defaultTier: string;
	respectExplicitModel: boolean;
	tiers: TierMap;
}

export const DEFAULT_PROMPT = `You are a routing classifier. Given a delegated task and its "solution space" (how open-ended the work is), output ONLY the identifier of the MINIMUM model tier required to complete it RELIABLY.

Guidance:
- Consider ambiguity, required reasoning depth, debugging with unknown cause, architectural/design choice, cross-cutting consequences, and consequences of being wrong.
- The number of files touched or the amount of mechanical work does NOT make a task harder by itself.
- A 100-file mechanical rename with exact names is easy. A 5-line concurrency bug with unknown cause and no repro is hard.
- When in doubt, choose the tier that guarantees correctness, not the cheapest guess.

Tiers:
{tiers}

Output format: reply with exactly one tier identifier as a single word, or a JSON object {"tier": "<id>", "reason": "<short reason>"}. Nothing else.`;

export const DEFAULT_TIERS: TierMap = {
	cheap: { model: "@tiny" },
	normal: { model: "@task" },
	hard: { model: "@slow" },
};

export const DEFAULT_CONFIG: RouterConfig = {
	enabled: true,
	classifier: {
		model: "@tiny",
		prompt: DEFAULT_PROMPT,
		timeoutMs: 8000,
		cache: true,
	},
	defaultTier: "normal",
	respectExplicitModel: true,
	tiers: DEFAULT_TIERS,
};

const CONFIG_DIR = () => {
	const xdg = process.env.XDG_CONFIG_HOME;
	return xdg ? `${xdg}/task-router` : `${process.env.HOME}/.omp/task-router`;
};

/** Never throws: invalid config disables routing, never breaks OMP startup. */
export async function loadConfig(): Promise<{ config: RouterConfig; error?: string }> {
	const base: RouterConfig = {
		...DEFAULT_CONFIG,
		classifier: { ...DEFAULT_CONFIG.classifier },
		tiers: { ...DEFAULT_TIERS },
	};
	try {
		const file = Bun.file(`${CONFIG_DIR()}/config.json`);
		if (!(await file.exists())) return { config: base };
		const raw = (await file.json()) as Partial<RouterConfig>;
		if (typeof raw.enabled === "boolean") base.enabled = raw.enabled;
		if (typeof raw.defaultTier === "string" && raw.defaultTier) base.defaultTier = raw.defaultTier;
		if (typeof raw.respectExplicitModel === "boolean") base.respectExplicitModel = raw.respectExplicitModel;
		if (raw.classifier && typeof raw.classifier === "object") {
			const c = raw.classifier as Partial<ClassifierConfig>;
			if (typeof c.model === "string" && c.model.trim()) base.classifier.model = c.model.trim();
			if (typeof c.prompt === "string" && c.prompt.includes("{tiers}")) base.classifier.prompt = c.prompt;
			else if (typeof c.prompt === "string" && c.prompt.trim()) base.classifier.prompt = `${c.prompt}\n\nTiers:\n{tiers}`;
			if (typeof c.timeoutMs === "number" && c.timeoutMs > 0) base.classifier.timeoutMs = c.timeoutMs;
			if (typeof c.cache === "boolean") base.classifier.cache = c.cache;
		}
		if (raw.tiers && typeof raw.tiers === "object") {
			const tiers: TierMap = {};
			for (const [id, value] of Object.entries(raw.tiers as TierMap)) {
				if (typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id) && typeof value?.model === "string" && value.model.trim()) {
					tiers[id] = { model: value.model.trim() };
				}
			}
			if (Object.keys(tiers).length > 0) base.tiers = tiers;
		}
		if (!base.tiers[base.defaultTier]) {
			// Correct silently: point defaultTier at the first surviving tier.
			base.defaultTier = Object.keys(base.tiers)[0] ?? "normal";
		}
		return { config: base };
	} catch (err) {
		// Malformed config must NOT silently reroute with defaults — disable routing
		// (fail-open: spawns run with OMP's own model choice until fixed).
		base.enabled = false;
		return { config: base, error: `task-router config invalid — routing disabled: ${err instanceof Error ? err.message : String(err)}` };
	}
}

export async function saveConfig(config: RouterConfig): Promise<void> {
	const dir = CONFIG_DIR();
	await mkdir(dir, { recursive: true });
	await Bun.write(`${dir}/config.json`, `${JSON.stringify(config, null, "\t")}\n`);
}

export function renderPromptForTiers(prompt: string, tiers: TierMap): string {
	const list = Object.keys(tiers)
		.map(id => `- ${id}`)
		.join("\n");
	return prompt.replace("{tiers}", list);
}

/** Is this task spawn exempt from routing (explicit model request)? */
export function isExplicitModelRequest(modelRole: string | undefined, respectExplicitModel: boolean): boolean {
	if (!respectExplicitModel) return false;
	// Inherited/agent-default roles route; anything else is an explicit selector.
	return modelRole !== undefined && modelRole !== "default" && modelRole !== "task";
}

export function preview(text: string | undefined, max = 80): string {
	const t = (text ?? "").replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}