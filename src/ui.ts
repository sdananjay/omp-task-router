import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { classify } from "./classifier";
import { loadConfig, preview, renderPromptForTiers, saveConfig } from "./config";
import type { RouterConfig } from "./config";
import type { Router } from "./router";

const OUTCOME_LABELS: Record<string, string> = {
	routed: "routed",
	router_disabled: "disabled",
	explicit_model_preserved: "explicit",
	classifier_failed: "cls-fail",
	classifier_timeout: "timeout",
	invalid_classifier_output: "bad-out",
	unknown_tier: "bad-tier",
	default_tier_used: "default",
	no_mapping: "no-map",
	task_left_unchanged: "unchanged",
};

export function formatHistoryTable(decisions: ReadonlyArray<ReturnType<Router["recent"]>[number]>): string {
	if (decisions.length === 0) return "task-router: no routing decisions this session.";
	const rows = [["#", "Tier", "Model", "Eff", "Out", "Task"].join("\t")];
	decisions.forEach((d, i) => {
		rows.push(
			[
				String(i + 1),
				d.selectedTier,
				d.mappedModel || "-",
				d.effort ?? "-",
				OUTCOME_LABELS[d.outcome] ?? d.outcome,
				d.taskPreview,
			].join("\t"),
		);
	});
	return rows.join("\n");
}

export function formatStatus(config: RouterConfig, decisionCount: number): string {
	const tiers = Object.entries(config.tiers)
		.map(([id, t]) => `${id}→${t.model}`)
		.join(", ");
	const promptPreview = preview(renderPromptForTiers(config.classifier.prompt, config.tiers), 120);
	return [
		`enabled: ${config.enabled}`,
		`classifier: ${config.classifier.model} (timeout ${config.classifier.timeoutMs}ms, cache ${config.classifier.cache ? "on" : "off"})`,
		`default tier: ${config.defaultTier}`,
		`respect explicit model: ${config.respectExplicitModel}`,
		`tiers: ${tiers}`,
		`prompt: ${promptPreview}`,
		`decisions this session: ${decisionCount}`,
	].join("\n");
}

export function formatTestResult(input: { task?: string; solutionSpace?: string }, decision: {
	selectedTier: string;
	mappedModel: string;
	classifierReason: string | undefined;
	outcome: string;
	classificationLatencyMs: number;
}): string {
	return [
		`task: ${preview(input.task) || "(none)"}`,
		`solutionSpace: ${preview(input.solutionSpace) || "(none)"}`,
		`tier: ${decision.selectedTier}`,
		`model: ${decision.mappedModel || "(unmapped)"}`,
		`reason: ${decision.classifierReason ?? "-"}`,
		`outcome: ${decision.outcome} (${decision.classificationLatencyMs}ms)`,
	].join("\n");
}

/** Register the /task-router command with subcommand + interactive menu. */
export function registerUi(pi: ExtensionAPI, getRouter: (ctx: ExtensionContext) => Promise<Router>, sessionId: () => string | undefined): void {
	pi.registerCommand("task-router", {
		description: "task-router status/enable/disable/history/test/prompt/tiers/reload",
		getArgumentCompletions: prefix =>
			["", "status", "enable", "disable", "history", "test", "prompt", "tiers", "reload"]
				.filter(sub => sub.startsWith(prefix.trim()))
				.map(sub => ({ value: sub, label: sub })),
		async handler(args, ctx) {
			const router = await getRouter(ctx);
			const sub = args.trim().split(/\s+/)[0] ?? "";
			switch (sub) {
				case "":
					await runMenu(ctx, router);
					break;
				case "status":
					ctx.ui.notify(formatStatus(router.config, router.history.length));
					break;
				case "enable":
					router.reload({ ...router.config, enabled: true });
					await persist(router);
					ctx.ui.notify("task-router enabled");
					break;
				case "disable":
					router.reload({ ...router.config, enabled: false });
					await persist(router);
					ctx.ui.notify("task-router disabled");
					break;
				case "history":
					ctx.ui.notify(formatHistoryTable(router.recent(25, sessionId())));
					break;
				case "test":
					await runTest(ctx, router);
					break;
				case "prompt":
					await editPrompt(ctx, router);
					break;
				case "tiers":
					await editTiers(ctx, router);
					break;
				case "reload": {
					const { config, error } = await loadConfig();
					router.reload(config);
					ctx.ui.notify(error ? `reloaded (with warning: ${error})` : "reloaded");
					break;
				}
				default:
					ctx.ui.notify(`unknown subcommand: ${sub}`, "warning");
			}
		},
	});
}

const persist = async (router: Router) => {
	await saveConfig(router.config);
};

async function runMenu(ctx: ExtensionContext, router: Router): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(formatStatus(router.config, router.history.length));
		return;
	}
	const MENU_ITEMS = [
		{ value: "status", label: "Status" },
		{ value: "history", label: "History" },
		{ value: "test", label: "Test classification" },
		{ value: router.config.enabled ? "disable" : "enable", label: enableChoiceLabel(router) },
		{ value: "prompt", label: "Edit classification prompt" },
		{ value: "tiers", label: "Edit config (tiers JSON)" },
		{ value: "reload", label: "Reload config" },
	] as const;
	// ponytail: ui.select returns labels, so encode the action in the label text
	// ("Status", "Disable routing") and match the label, not a hidden value.
	const choice = await ctx.ui.select(
		"task-router",
		MENU_ITEMS.map(item => ({ label: item.label })),
	);
	if (!choice) return;
	const selected = MENU_ITEMS.find(item => item.label === choice)?.value;
	switch (selected) {
		case "status":
			ctx.ui.notify(formatStatus(router.config, router.history.length));
			break;
		case "history":
			ctx.ui.notify(formatHistoryTable(router.recent(25, undefined)));
			break;
		case "test":
			await runTest(ctx, router);
			break;
		case "enable":
		case "disable":
			router.reload({ ...router.config, enabled: selected === "enable" });
			await persist(router);
			ctx.ui.notify(`task-router ${selected}d`);
			break;
		case "prompt":
			await editPrompt(ctx, router);
			break;
		case "tiers":
			await editTiers(ctx, router);
			break;
		case "reload": {
			const { config, error } = await loadConfig();
			router.reload(config);
			ctx.ui.notify(error ? `reloaded (with warning: ${error})` : "reloaded");
			break;
		}
	}
}

function enableChoiceLabel(router: Router): string {
	return router.config.enabled ? "Disable routing" : "Enable routing";
}

async function runTest(ctx: ExtensionContext, router: Router): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("task-router test needs interactive UI", "warning");
		return;
	}
	const task = await ctx.ui.input("Task (leave empty to skip)");
	const solutionSpace = await ctx.ui.input("Solution space (how open-ended is the work?)");
	try {
		const tiers = router.config.tiers;
		const started = performance.now();
		const classified = await classify(
			{ task: task || undefined, solutionSpace: solutionSpace || undefined },
			ctx,
			router.config,
			Object.keys(tiers),
			undefined,
		);
		const latency = Math.round(performance.now() - started);
		const tierId = tiers[classified.tier ?? ""] ? classified.tier! : router.config.defaultTier;
		ctx.ui.notify(
			formatTestResult(
				{ task: task || undefined, solutionSpace: solutionSpace || undefined },
				{
					selectedTier: tierId,
					mappedModel: tiers[tierId]?.model ?? "",
					classifierReason: classified.reason,
					outcome: tiers[classified.tier ?? ""] ? "routed" : "unknown_tier",
					classificationLatencyMs: latency,
				},
			),
		);
	} catch (err) {
		ctx.ui.notify(`task-router test failed: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

async function editPrompt(ctx: ExtensionContext, router: Router): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("task-router prompt editing needs interactive UI", "warning");
		return;
	}
	const edited = await ctx.ui.editor(
		"Classification prompt ({tiers} expands to configured tier ids)",
		router.config.classifier.prompt,
	);
	if (edited === undefined) return;
	router.reload({
		...router.config,
		classifier: { ...router.config.classifier, prompt: edited.includes("{tiers}") ? edited : `${edited}\n\nTiers:\n{tiers}` },
	});
	await persist(router);
	ctx.ui.notify("classification prompt saved");
}

async function editTiers(ctx: ExtensionContext, router: Router): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("task-router tier editing needs interactive UI", "warning");
		return;
	}
	const current = JSON.stringify(
		{ defaultTier: router.config.defaultTier, tiers: router.config.tiers },
		null,
		2,
	);
	const edited = await ctx.ui.editor("Edit tiers JSON", current);
	if (edited === undefined) return;
	try {
		const parsed = JSON.parse(edited) as { defaultTier?: string; tiers?: RouterConfig["tiers"] };
		if (!parsed.tiers || Object.keys(parsed.tiers).length === 0) throw new Error("tiers must retain at least one entry");
		const defaultTier = parsed.defaultTier ?? router.config.defaultTier;
		if (!parsed.tiers[defaultTier]) throw new Error(`defaultTier "${defaultTier}" must be one of the tiers`);
		router.reload({ ...router.config, defaultTier, tiers: parsed.tiers });
		await persist(router);
		ctx.ui.notify("tiers saved");
	} catch (err) {
		ctx.ui.notify(`invalid tiers JSON: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}