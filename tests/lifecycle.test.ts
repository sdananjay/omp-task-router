import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, Settings, AgentRegistry, type ExtensionContext, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cfgTaskMaxConcurrency } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import taskRouterExtension from "../src/index";
import { classify } from "../src/classifier";
import { DEFAULT_CONFIG } from "../src/config";
import { Router } from "../src/router";

// Script only the provider transport; OMP owns argument preparation, validation,
// tool rejection, TaskTool execution, spawn hooks, model resolution, and children.
async function lifecycleScenario() {
	const dir = await mkdtemp(join(tmpdir(), "task-router-lifecycle-"));
	const previousXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = dir;
	const auth = await AuthStorage.create(join(dir, "auth.db"));
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.speculativeLaunch": false,
		"task.batch": true,
		modelRoles: { default: "router-test/parent", task: "router-test/normal", tiny: "router-test/classifier", slow: "router-test/hard" },
	});
	const registry = new ModelRegistry(auth, join(dir, "models.yml"), { settings, fetch: async () => { throw new Error("external network forbidden"); } });
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const scripts: ToolCall[][] = [];
	const classified: string[] = [];
	const children: { model: string; assignment: string }[] = [];
	const spawnKeys: (string | undefined)[] = [];
	const ends: { id: string; isError: boolean }[] = [];
	const secondBatchSpawn = Promise.withResolvers<void>();
	const asyncCallReturned = Promise.withResolvers<void>();
	let ctx: ExtensionContext | undefined;
	let abortCaller: (() => void) | undefined;
	const provider: ProviderConfigInput = {
		api: "router-test-api", apiKey: "local-test", baseUrl: "http://localhost.invalid",
		models: ["parent", "classifier", "cheap", "normal", "hard", "timeout", "timeout-reject", "aborted", "failure"].map(id => ({ id, name: id, reasoning: false, input: ["text"], supportsTools: true, cost, contextWindow: 128000, maxTokens: 4096 })),
		streamSimple(model, context, options) {
			const stream = new AssistantMessageEventStream();
			const assignment = context.messages.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
			const finish = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") => {
				const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(), usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } } };
				stream.push({ type: "start", partial: message });
				content.forEach((block, contentIndex) => {
					if (block.type !== "toolCall") return;
					stream.push({ type: "toolcall_start", contentIndex, partial: message });
					stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial: message });
					stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
				});
				if (stopReason === "aborted" || stopReason === "error") stream.push({ type: "error", reason: stopReason, error: message });
				else stream.push({ type: "done", reason: stopReason, message });
				stream.end(message);
			};
			queueMicrotask(() => {
				if (model.id === "timeout" || model.id === "timeout-reject") {
					const abort = () => model.id === "timeout-reject" ? stream.fail(new Error("transport cancelled")) : finish([], "aborted");
					if (options?.signal?.aborted) abort();
					else options?.signal?.addEventListener("abort", abort, { once: true });
					abortCaller?.();
					abortCaller = undefined;
				} else if (model.id === "aborted") finish([], "aborted");
				else if (model.id === "failure") finish([], "error");
				else if (model.id === "classifier") {
					if (assignment.startsWith("Task:\n")) classified.push(assignment);
					finish([{ type: "text", text: assignment.includes("hard-task") ? "hard" : "cheap" }]);
				} else if (model.id === "parent") {
					const calls = context.messages.at(-1)?.role === "user" && context.tools?.some(tool => tool.name === "task") ? scripts.shift() : undefined;
					finish(calls ?? [{ type: "text", text: "done" }], calls ? "toolUse" : "stop");
				} else {
					children.push({ model: model.id, assignment });
					finish([{ type: "toolCall", id: `yield-${children.length}`, name: "yield", arguments: { data: { model: model.id } } }], "toolUse");
				}
			});
			return stream;
		},
	};
	const config = { ...DEFAULT_CONFIG, classifier: { ...DEFAULT_CONFIG.classifier, model: "router-test/classifier" }, tiers: { cheap: { model: "router-test/cheap" }, normal: { model: "router-test/normal" }, hard: { model: "router-test/hard" } } };
	await mkdir(join(dir, "task-router"));
	await Bun.write(join(dir, "task-router/config.json"), JSON.stringify(config));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		({ session } = await createAgentSession({
			cwd: dir, agentDir: dir, authStorage: auth, modelRegistry: registry, settings,
			modelPattern: "router-test/parent",
			sessionManager: SessionManager.inMemory(dir), agentRegistry: new AgentRegistry(),
			disableExtensionDiscovery: true, autoApprove: true, toolNames: ["task"],
			enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
			skills: [], rules: [], contextFiles: [], promptTemplates: [], systemPrompt: "Local integration test", cacheWarming: false,
			extensions: [pi => pi.registerProvider("router-test", provider), pi => {
				pi.on("before_subagent_spawn", async event => {
					if (event.spawnKey === "batch:0") await secondBatchSpawn.promise;
					if (event.spawnKey === "Unbound-2") await asyncCallReturned.promise;
				});
			}, taskRouterExtension, pi => {
				pi.on("tool_call", event => event.toolCallId === "rejected" ? { block: true, reason: "test rejection" } : undefined);
				pi.on("before_subagent_spawn", (event, context) => {
					ctx = context;
					spawnKeys.push(event.spawnKey);
					if (event.spawnKey === "batch:1") secondBatchSpawn.resolve();
				});
				pi.on("tool_execution_end", event => {
					if (event.toolName === "task") ends.push({ id: event.toolCallId, isError: event.isError });
					if (event.toolCallId === "async") asyncCallReturned.resolve();
				});
			}],
		}));
		// Commands must work before any delegated task, including with non-default config.
		const notices: string[] = [];
		const testInputs = ["hard-task-command", "Unknown cause; inspect synchronization paths"];
		assert(session.extensionRunner);
		await initializeExtensions(session, {
			reportSendError: (_action, error) => { throw error; },
			reportRuntimeError: error => { throw new Error(error.error); },
			uiContext: {
				...session.extensionRunner.getUIContext(),
				notify: message => { notices.push(message); },
				select: async () => "Disable routing",
				input: async () => testInputs.shift(),
			},
		});
		await session.prompt("/task-router status");
		const startupStatus = notices.at(-1)!;
		assert.match(startupStatus, /enabled: true/);
		assert.match(startupStatus, /classifier: router-test\/classifier/);
		assert.equal(children.length, 0);
		assert.equal(classified.length, 0);
		await session.prompt("/task-router");
		const disabledConfig = await Bun.file(join(dir, "task-router/config.json")).json();
		assert.equal(disabledConfig.enabled, false);
		assert.equal(disabledConfig.respectExplicitModel, true);
		await session.prompt("/task-router test");
		const testResult = notices.at(-1)!;
		assert.match(testResult, /tier: hard/);
		assert.match(testResult, /model: router-test\/hard/);
		assert.equal(children.length, 0);
		assert.equal(classified.length, 1);
		classified.length = 0;
		await session.prompt("/task-router enable");
		assert.equal((await Bun.file(join(dir, "task-router/config.json")).json()).enabled, true);
		if (process.argv.includes("--smoke")) console.log(`Fresh-session status:\n${startupStatus}\nClassifier test without a delegated task:\n${testResult}`);

		const item = (task: string, agent = "task") => ({ agent, task, solutionSpace: `solution-${task}` });
		const call = (id: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name: "task", arguments: args });
		for (const calls of [
			[call("rejected", item("hard-task-rejected"))],
			[call("failed", item("hard-task-invalid", "missing-agent"))],
			[call("batch", { context: "Local routing regression", tasks: [item("cheap-task-batch"), item("hard-task-batch")] })],
			[call("overlap-a", item("hard-task-overlap")), call("overlap-b", item("cheap-task-overlap"))],
		]) {
			scripts.push(calls);
			await session.prompt("Run the next scripted tools");
		}
		assert(ends.some(end => end.id === "rejected" && end.isError));
		assert(ends.some(end => end.id === "failed" && end.isError));
		assert.deepEqual(classified.map(text => text.match(/Task:\n([^\n]+)/)?.[1]).sort(), ["cheap-task-batch", "cheap-task-overlap", "hard-task-batch", "hard-task-overlap"]);
		assert.deepEqual(spawnKeys.slice(0, 2), ["batch:1", "batch:0"]);
		assert.deepEqual([...spawnKeys].sort(), ["batch:0", "batch:1", "overlap-a:0", "overlap-b:0"]);
		for (const child of children) assert.equal(child.model, child.assignment.includes("hard-task") ? "hard" : "cheap");
		assert.deepEqual(children.map(child => child.model).sort(), ["cheap", "cheap", "hard", "hard"]);

		scripts.push([call("named", { context: "Named task with no origin binding", tasks: [{ ...item("hard-task-unbound-name"), name: "Unbound" }] })]);
		await session.prompt("Run the next scripted tools");
		assert.equal(spawnKeys.at(-1), "Unbound");
		assert.equal(classified.some(text => text.includes("hard-task-unbound-name")), false);
		assert.equal(children.at(-1)?.model, "normal");

		scripts.push([
			call("collision", { context: "A name must not impersonate a call:index", tasks: [{ ...item("hard-task-collision"), name: "target:0" }] }),
			call("target", item("cheap-task-target")),
		]);
		await session.prompt("Run the next scripted tools");
		assert.equal(children.find(child => child.assignment.includes("hard-task-collision"))?.model, "normal");
		assert.equal(classified.some(text => text.includes("hard-task-collision")), false);

		// Both IDs must survive tool settlement, including the second queued spawn.
		cfgAsyncEnabled.override(settings, true);
		cfgTaskMaxConcurrency.override(settings, 1);
		scripts.push([call("async", { context: "Background ID correlation", tasks: [
			{ ...item("hard-task-async"), name: "Unbound" },
			{ ...item("cheap-task-async"), name: "Unbound-2" },
		] })]);
		await session.prompt("Run the next scripted tools");
		assert(session.asyncJobManager);
		await session.asyncJobManager.waitForAll();
		assert(ends.some(end => end.id === "async" && !end.isError));
		assert.equal(children.find(child => child.assignment.includes("hard-task-async"))?.model, "hard");
		assert.equal(children.find(child => child.assignment.includes("cheap-task-async"))?.model, "cheap");
		assert.deepEqual(spawnKeys.slice(-2), ["Unbound-2", "Unbound-2-2"]);

		// Exercise real completeSimple responses and native AbortSignal.timeout;
		// fake JS timers cannot drive the platform-owned abort signal.
		const routingInput = { task: "timeout-task", solutionSpace: undefined, effort: undefined, agent: "task", invocationKind: "task" as const, modelRole: "task", patterns: [] };
		for (const [model, callerAbort, expected] of [
			["timeout", false, "classifier_timeout"],
			["timeout", true, "classifier_timeout"],
			["timeout-reject", false, "classifier_timeout"],
			["aborted", false, "classifier_timeout"],
			["failure", false, "classifier_failed"],
		] as const) {
			const controller = new AbortController();
			abortCaller = callerAbort ? () => controller.abort() : undefined;
			const cfg = { ...config, classifier: { ...config.classifier, model: `router-test/${model}`, timeoutMs: 20 } };
			const router = new Router(cfg, (input, current, signal) => classify(input, ctx!, current, Object.keys(current.tiers), signal));
			const verdict = await router.route(routingInput, callerAbort ? controller.signal : undefined);
			assert.equal(verdict.decision.outcome, expected);
			assert.equal(verdict.result?.model, "router-test/normal");
			assert.equal(router.history.at(-1)?.outcome, expected);
		}
	} finally {
		await session?.dispose();
		registry.unregisterProvider("router-test");
		auth.close();
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previousXdg;
		await rm(dir, { recursive: true, force: true });
	}
}

if (process.argv.includes("--smoke")) {
	await lifecycleScenario();
	console.log("OMP lifecycle smoke passed: fresh-session commands, persisted toggles, classifier test, rejection, preflight failure, reversed batch, overlapping calls, queued background IDs, name collisions, timeout and abort fallbacks");
	// One-shot SDK host: async artifact-retention timers can outlive disposal.
	process.exit(0);
} else {
	const { test } = await import("bun:test");
	test("OMP lifecycle initializes commands before tasks and safely correlates delegated spawns", lifecycleScenario, 60000);
}
