# OMP (can1357/oh-my-pi) Integration Notes

Verified against `@oh-my-pi/pi-coding-agent@<installed>` source at
`~/.omp/plugins/node_modules/@oh-my-pi/` (paths below relative to that root,
unless prefixed otherwise). OMP binary: `omp/18.4.12` — the binary itself is
compiled; the extension surface is the TS in these packages. User config:
`~/.omp/agent/config.yml` contains `modelRoles:` (default, smol, slow, plan,
task, tiny, memory, advisor, commit) and `retry.fallbackChains`.

## 1. Extension loading

- `pi-coding-agent/src/extensibility/extensions/loader.ts::loadExtensions(paths, cwd, eventBus)`
  imports extension modules and binds them per-session via
  `bindPreparedExtensions`. Root session imports once; subagents rebind without
  re-evaluating the module graph.
- An extension module default-exports an `ExtensionFactory`
  (`src/extensibility/extensions/types.ts:1778`):
  `(pi: ExtensionAPI) => void | Promise<void>`.
- Discovery (`getEnabledPlugins` in `src/extensibility/plugins/loader.ts`):
  packages under `<plugins>/node_modules` with `package.json` declaring an
  `omp` or `pi` manifest field are plugins. Manifest shape
  (`src/extensibility/plugins/types.ts::PluginManifest`): `{ name?, version,
  description?, tools?, hooks?, extensions?: string[], commands?, features?,
  settings? }`.
  Real example: `@dietrichgebert/ponytail/package.json` →
  `"pi": { "extensions": ["./pi-extension/index.js"], "skills": ["./skills"] }`.
- Install: `omp plugin install <pkg|git-url>` (+ `omp plugin link` for dev);
  state lives in `<plugins>/omp-plugins.lock.json`
  (`pi-utils/src/dirs.ts::getPluginsDir`, `getPluginsLockfile`).

## 2. Task interception

Two candidate hooks; `before_subagent_spawn` is the supported one.

### a) `tool_call` event

`src/extensibility/extensions/types.ts:1064+`: `ToolCallEvent` union → for the
task tool it's a `CustomToolCallEvent { type, toolCallId, toolName: string,
input: Record<string, unknown> }` — the **raw, pre-validation tool input**.
Handler may return `ToolCallEventResult` (`shared-events.ts:325`):

```ts
{ block?: true; reason?: string;
  input?: Record<string, unknown>;   // replacement input, last-wins across extensions
  additionalContext?: string }
```

Caveats found in source: the returned `input` is "revalidated against the tool
schema" for model-issued calls; nested/dispatched calls have different paths.
For `task`, the actual wire schema (`src/task/types.ts:44+`,
arktype, `"+": "delete"` strips unknown keys) is
`{ name?, agent (= 'task' default), task, solutionSpace, outputSchema?,
schemaMode?, tools?, isolated?, effort? }` (+ `context, tasks[]` in batch
mode). **No `model` field on the task tool wire schema.** Also `lenientArgValidation
= true` on TaskTool, unknown keys would be forwarded raw.

`ToolCallEventResult.input` replaces the input used by the tool's `execute`.
Since the schema strips unknown keys and the tool maps `TaskParams -> request`
through explicit field copies (`src/task/index.ts:1605+`), the task tool
**cannot be told "route to role X" via the input** — there is no model passthrough
field to inject. So `tool_call` alone can't retarget spawn model.

### b) `before_subagent_spawn` (chosen)

`types.ts:853`: fires **in the parent session, before a subagent resolves its
model**, for task-tool spawns AND eval `agent()`:

```ts
{ type: "before_subagent_spawn";
  agent: string;                 // agent definition name ("task", "scout", ...)
  invocationKind: "task" | "eval";
  modelRole?: string;            // pre-expansion role alias ("task" for @task); undefined for explicit selectors
  patterns: string[];            // expanded model patterns in attempt order
  spawnKey?: string }
```

Emitted exactly once per actual child dispatch
(`src/task/structured-subagent.ts::applySpawnHook`, called from
`runStructuredSubagent` at line ~708).

Result type (`types.ts:1299`):

```ts
BeforeSubagentSpawnEventResult {
  model?: string | string[];  // replacement patterns in attempt order; "Role identity is preserved"
  note?: string;              // shown to user as resolvedModelRoute
  block?: boolean; reason?: string;
}
```

Replacement path (`structured-subagent.ts:421-430`):
`resolveConfiguredModelPatterns(spawnResult.model, settings)` → expands `@x`
role aliases against `modelRoles` in config.yml → `policy.modelOverride` +
`modelRoute: note`.
**Fallback chains survive**: `modelOverride` (patterns, expanded or raw)
still flows into `resolveInheritedRetryFallbackChain` keyed by role
(`executor.ts:263-269`, `4145-4151` only take the `modelOverride === undefined`
shortcut when no model was set — when we set one, role-based fallback is
supplied by us or by `modelRole` preserved). Verified semantics: setting
`model` on this hook is exactly the built-in "model-pools" style routing
seam, comment says "Extension routing note (e.g. model-pools) explaining why
resolvedModel was chosen."
- Distinguishing explicit-vs-inherited model at this event = compare
  `event.patterns` after `resolveAgentModelSelection(...)`. If the source
  selector resolved to a pattern, `modelRole` is **undefined** whenever the
  selection came from a non-role-alias source (explicit model / pattern);
  inherited/agent-default (`@task`) has `modelRole: "task"`,
  inherited session default has `modelRole: "default"` via
  `isSessionInheritedAgentPattern` (`model-resolver.ts:1086-1091`).

### Why not `tool_call`

- `task` wire schema has no `model` selector, and arktype `"+": "delete"`
  strips unknown keys, so returning `{input: {...input, model: "@task_hard"}}`
  would be silently dropped at validation, or forwarded raw under
  `lenientArgValidation` then ignored by `TaskParams -> StructuredSubagentRequest`
  mapping (there is no `params.model` in `#runSpawn`, `src/task/index.ts:1605+`).
  Verified: `TaskParams` has no `model` field.
- `before_subagent_spawn` is a purpose-built extension seam with exactly the
  intended semantics ("Role identity is preserved", `note` displayed in UI,
  explicit routing comment referencing model-pools). It fires for every real
  child dispatch, so stateful per-spawn classification is one event per child
  (@src/task/structured-subagent.ts:397-401 "stateful routing handlers must see
  exactly one event per spawned child").

## 3. Classifying with a model — no agent, no turn

`ExtensionContext.models: ExtensionModelQuery` (`types.ts:437-449`), available
in `tool_call`/`before_subagent_spawn` handler ctx:

```ts
models.resolve(spec: string): Model | undefined
// resolves "provider/id", bare id, or role alias `@x` ("using the same
// settings-backed aliases and match preferences as core selection")
```

Then call the model directly with `completeSimple` from `@oh-my-pi/pi-ai`
(`pi-ai/src/stream.ts:1595`), as OMP's own bundled `annotate/text-summary.ts`
does:

```ts
import { completeSimple } from "@oh-my-pi/pi-ai";
const model = ctx.models.resolve("@tiny");
const message = await completeSimple(model, {
  systemPrompt: [...],
  messages: [{ role: "user", content: ..., timestamp: Date.now() }],
}, {
  apiKey: ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId()),
  disableReasoning: true,      // utility call, suppress reasoning
  maxTokens: 512,
  signal,
});
```

`disableReasoning` (pi-ai `types.ts:~707`): "Useful for fast utility calls
(e.g. title generation) where the model would otherwise burn the entire output
budget on internal thinking" — exactly our classifier use case. Message
stopReason `error`/`aborted` → treat as classification failure (fail-open).

## 4. Config storage

- Plugin manifest `settings` (`PluginSettingSchema` = flat
  string/number/boolean/enum fields, `plugins/types.ts:44-68`) is meant for
  single-value settings via `omp plugin config <name> <key>`
  (`src/cli/plugin-cli.ts:927-999`), persisted into
  `~/.omp/plugins/omp-plugins.lock.json` (`PluginRuntimeConfig.settings`).
  Read back via `PluginManager.getPluginSettings(name)`.
- Extension modules just read files directly; ponytail does
  `$XDG_CONFIG_HOME/ponytail/config.json` JSON.
- **Decision**: YAML file `~/.omp/task-router/tiers.yml` doesn't exist as a
  convention; simplest true-to-OMP store is a JSON file under
  `~/.omp/task-router/config.json`. OMP core `settings` registry
  (`config/registry.ts::register`) is for core settings, not per-plugin
  nested config; plugin manifest settings only support flat values, so nested
  tiers/prompt cannot ride those. Custom JSON file it is.

## 5. UI

`ExtensionContext.ui: ExtensionUIContext` (`types.ts:258+`):
- `select(title, options, dialogOptions?) → string | undefined`
- `confirm(title, message) → boolean`
- `input(title, placeholder?) → string | undefined`
- `editor(title, prefill?, dialogOptions?, { promptStyle? }) → string | undefined` — **multiline
  editor exists**, good for the classification prompt.
- `notify(message, "info" | "warning" | "error")`
- Commands: `pi.registerCommand(name, { description?, getArgumentCompletions?,
  handler(args, ctx: ExtensionCommandContext) })` (`types.ts:1518`);
  subcommand parsing is ours (ponytail pattern). `getArgumentCompletions`
  gives autocomplete for subcommands (`AutocompleteItem`).
- `ctx.mode`, `ctx.hasUI` guard interactivity in print/RPC modes.

## 6. Explicit model on task input

The `task` tool wire schema has **no `model` parameter**. Explicit model
selection for subagents happens through:
- `task.agentModelOverrides` setting (per-agent-name model overrides),
- agent definitions' own `model: "@task"` frontmatter,
- session active model (`--model`).
At `before_subagent_spawn`, we can only see `modelRole` + `patterns`. We can
detect "explicit" as `modelRole === undefined` (no role-alias source) but NOT
as "explicitly chosen by the user in the tool call" (no such channel).
Documented limitation, see design.md.