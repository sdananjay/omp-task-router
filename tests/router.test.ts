import { describe, expect, test } from "bun:test";
import { parseClassifierOutput } from "../src/classifier";
import { DEFAULT_PROMPT, DEFAULT_TIERS, preview, renderPromptForTiers } from "../src/config";
import type { RouterConfig } from "../src/config";
import { Router } from "../src/router";
import type { ClassifyFn, RoutingInput } from "../src/router";

const CFG: RouterConfig = {
	enabled: true,
	classifier: { model: "@tiny", prompt: DEFAULT_PROMPT, timeoutMs: 8000, cache: true },
	defaultTier: "normal",
	respectExplicitModel: true,
	tiers: DEFAULT_TIERS,
};

function input(overrides: Partial<RoutingInput> = {}): RoutingInput {
	return {
		task: "Fix the pagination off-by-one",
		solutionSpace: "one fix: slice end in paginate",
		agent: "task",
		invocationKind: "task",
		modelRole: "task",
		patterns: ["ollama-cloud/glm-5.3-flash"],
		effort: undefined,
		...overrides,
	};
}

describe("review fixes", () => {
	test("pretty-printed multiline JSON parses", () => {
		const parsed = parseClassifierOutput('{\n  "tier": "hard",\n  "reason": "open-ended"\n}', ["cheap", "normal", "hard"]);
		expect(parsed.tier).toBe("hard");
		expect(parsed.reason).toBe("open-ended");
	});

	test("fenced pretty-printed JSON parses", () => {
		const parsed = parseClassifierOutput('```json\n{\n  "tier": "cheap"\n}\n```', ["cheap", "normal", "hard"]);
		expect(parsed.tier).toBe("cheap");
	});

	test("undefined modelRole = explicit selector, preserved", async () => {
		const router = new Router(CFG, async () => ({ tier: "hard", reason: undefined }));
		const verdict = await router.route(input({ modelRole: undefined }), undefined);
		expect(verdict.result).toBeUndefined();
		expect(verdict.decision.outcome).toBe("explicit_model_preserved");
	});

	test("respectExplicitModel=false routes undefined-modelRole spawns", async () => {
		const router = new Router({ ...CFG, respectExplicitModel: false }, async () => ({ tier: "hard", reason: undefined }));
		const verdict = await router.route(input({ modelRole: undefined }), undefined);
		expect(verdict.result?.model).toBe("@slow");
	});

	test("warm cache survives mapping changes but not classifier inputs", async () => {
		let calls = 0;
		const router = new Router(CFG, async () => { calls++; return { tier: "cheap", reason: undefined }; });
		await router.route(input(), undefined);
		router.reload({ ...CFG });
		await router.route(input(), undefined);
		expect(calls).toBe(1);
		router.reload({ ...CFG, tiers: { ...CFG.tiers, cheap: { model: "@other" } } });
		expect((await router.route(input(), undefined)).result?.model).toBe("@other");
		expect(calls).toBe(1);
		router.reload({ ...CFG, classifier: { ...CFG.classifier, prompt: "Changed {tiers}" } });
		await router.route(input(), undefined);
		expect(calls).toBe(2);
		router.reload({ ...CFG, classifier: { ...CFG.classifier, model: "@other" } });
		await router.route(input(), undefined);
		expect(calls).toBe(3);
	});

	test("an in-flight old classification cannot repopulate the new tier cache", async () => {
		const first = Promise.withResolvers<{ tier: string; reason: undefined }>();
		let calls = 0;
		const router = new Router(CFG, async (_, config) => {
			calls++;
			return calls === 1 ? first.promise : { tier: config.tiers.cheap ? "cheap" : "budget", reason: undefined };
		});
		const pending = router.route(input(), undefined);
		router.reload({ ...CFG, tiers: { budget: { model: "@tiny" }, normal: CFG.tiers.normal!, hard: CFG.tiers.hard! } });
		first.resolve({ tier: "cheap", reason: undefined });
		await pending;
		const verdict = await router.route(input(), undefined);
		expect(verdict.result?.model).toBe("@tiny");
		expect(verdict.decision.outcome).toBe("routed");
		expect(calls).toBe(2);
	});

	test("renaming a tier reclassifies the same task instead of using a removed tier", async () => {
		let calls = 0;
		const router = new Router(CFG, async (_, config) => {
			calls++;
			return { tier: config.tiers.cheap ? "cheap" : "budget", reason: undefined };
		});
		await router.route(input(), undefined);
		router.reload({ ...CFG, tiers: { budget: { model: "@tiny" }, normal: CFG.tiers.normal!, hard: CFG.tiers.hard! } });
		const verdict = await router.route(input(), undefined);
		expect(verdict.result?.model).toBe("@tiny");
		expect(verdict.decision.outcome).toBe("routed");
		expect(calls).toBe(2);
	});
});

describe("classifier output parser", () => {
	const tiers = Object.keys(DEFAULT_TIERS);
	test("bare word", () => {
		expect(parseClassifierOutput("cheap", tiers)).toEqual({ tier: "cheap", reason: undefined });
	});
	test("word with punctuation", () => {
		const parsed = parseClassifierOutput("Hard.", tiers);
		expect(parsed.tier).toBe("hard");
	});
	test("json object", () => {
		expect(parseClassifierOutput('{"tier":"hard","reason":"unknown cause"}', tiers)).toEqual({
			tier: "hard",
			reason: "unknown cause",
		});
	});
	test("fenced json", () => {
		expect(parseClassifierOutput('```json\n{"tier":"cheap","reason":"mechanical"}\n```', tiers)).toEqual({
			tier: "cheap",
			reason: "mechanical",
		});
	});
	test("case-insensitive tier", () => {
		expect(parseClassifierOutput("HARD", tiers)?.tier).toBe("hard");
	});
	test("unknown tier is surfaced, not coerced", () => {
		expect(parseClassifierOutput("frontier", tiers)?.tier).toBeUndefined();
	});
	test("garbage", () => {
		expect(parseClassifierOutput("total nonsense with no tier", tiers)?.tier).toBeUndefined();
	});
	test("empty", () => {
		expect(parseClassifierOutput(undefined, tiers)?.tier).toBeUndefined();
	});
});

describe("router", () => {
	const classifyHard: ClassifyFn = async () => ({ tier: "hard", reason: "open-ended" });
	const classifyFail: ClassifyFn = async () => undefined;

	test("routes classified tier to configured model, effort untouched", async () => {
		const router = new Router(CFG, classifyHard);
		const verdict = await router.route(input({ effort: "lo" }), undefined);
		expect(verdict.result?.model).toBe("@slow");
		expect(verdict.decision.outcome).toBe("routed");
		expect(verdict.decision.effort).toBe("lo");
		// Regression: router result NEVER contains an effort field.
		expect(Object.keys(verdict.result ?? {})).toEqual(["model", "note"]);
	});

	test("classifier failure falls back to defaultTier mapping", async () => {
		const router = new Router(CFG, classifyFail);
		const verdict = await router.route(input(), undefined);
		expect(verdict.result?.model).toBe("@task");
		expect(verdict.decision.outcome).toBe("classifier_failed");
		expect(verdict.decision.selectedTier).toBe("normal");
	});

	test("unknown tier falls back to defaultTier", async () => {
		const router = new Router(CFG, async () => ({ tier: "frontier", reason: "x" }));
		const verdict = await router.route(input(), undefined);
		expect(verdict.result?.model).toBe("@task");
		expect(verdict.decision.outcome).toBe("unknown_tier");
	});

	test("explicit model request preserved", async () => {
		const router = new Router(CFG, classifyHard);
		const verdict = await router.route(input({ modelRole: "task_cheap" }), undefined);
		expect(verdict.result).toBeUndefined();
		expect(verdict.decision.outcome).toBe("explicit_model_preserved");
	});

	test("respectExplicitModel=false routes explicit roles too", async () => {
		const router = new Router({ ...CFG, respectExplicitModel: false }, classifyHard);
		const verdict = await router.route(input({ modelRole: "task_cheap" }), undefined);
		expect(verdict.result?.model).toBe("@slow");
	});

	test("router disabled leaves input untouched", async () => {
		const router = new Router({ ...CFG, enabled: false }, classifyHard);
		const verdict = await router.route(input(), undefined);
		expect(verdict.result).toBeUndefined();
		expect(verdict.decision.outcome).toBe("router_disabled");
	});

	test("cache honors same task+solutionSpace", async () => {
		let calls = 0;
		const classifyCounting: ClassifyFn = async () => {
			calls++;
			return { tier: "cheap", reason: undefined };
		};
		const router = new Router(CFG, classifyCounting);
		const first = await router.route(input(), undefined);
		const second = await router.route(input(), undefined);
		expect(calls).toBe(1);
		expect(first.result?.model).toBe("@tiny");
		expect(second.result?.model).toBe("@tiny");
	});

	test("history records decision", async () => {
		const router = new Router(CFG, classifyHard);
		await router.route(input(), undefined);
		expect(router.history.length).toBe(1);
		expect(router.history[0]?.classifierTier).toBe("hard");
		expect(router.history[0]?.selectedTier).toBe("hard");
	});
});

describe("config helpers", () => {
	test("renderPromptForTiers substitutes tiers", () => {
		const rendered = renderPromptForTiers(DEFAULT_PROMPT, DEFAULT_TIERS);
		expect(rendered).toContain("- cheap");
		expect(rendered).toContain("- normal");
		expect(rendered).toContain("- hard");
	});

	test("preview truncates", () => {
		expect(preview("x".repeat(100))).toHaveLength(80);
	});

});