# OMP (can1357/oh-my-pi) Integration Notes

Lifecycle correlation rechecked against this checkout's installed
`@oh-my-pi/pi-coding-agent@18.6.3` source under `node_modules/@oh-my-pi/`.
Paths below are relative to that package root. The regression and standalone
smoke run actual SDK sessions with a local scripted provider, not cloud inference.
OMP model roles and fallback chains remain configured in
`~/.omp/agent/config.yml`.

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
`{ name?, agent (= 'task' default), task, solutionSpace, model?, outputSchema?,
schemaMode?, tools?, isolated?, effort? }` (+ `context, tasks[]` in batch mode).
Current OMP supports explicit `model` selectors. The router observes inputs but
never rewrites them; inherited model routing happens at the spawn hook.

`tool_call` precedes validation/approval and need not produce a spawn.
`tool_execution_start` supplies the executed arguments. `tool_execution_update`
supplies TaskTool progress rows with original `index` and allocated `id`.
`tool_result` / `tool_execution_end` settle calls; approval rejection can occur
without a tool-result event, so `tool_approval_resolved` also purges pending text.

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

`applySpawnHook` chooses `identity.id ?? identity.label ??
(parentToolCallId + ":" + index)`. Allocated IDs and labels are not origin call
IDs. The router matches only indexed keys or IDs bound by progress events;
unknown/ambiguous keys leave the spawn untouched. Named synchronous and early
speculative launches without progress binding cannot be routed safely with the
current event contract. Full coverage needs origin call ID/index on the event.

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
- Preservation is determined from `event.modelRole`, not by comparing expanded
  `event.patterns`. Non-role selectors have undefined `modelRole` and are
  preserved when `respectExplicitModel` is true. Generic `task`/`default` roles
  and configured tier IDs remain routable; other role aliases are preserved.
  An explicitly supplied `@task` is indistinguishable from the agent default
  at this hook and is intentionally routable.

### Why not `tool_call`

- Rewriting `task` input would mix routing with explicit selectors and bypass
  the purpose-built spawn seam. Observe task text, then return a model only
  from `before_subagent_spawn` after checking OMP's `modelRole` policy.
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

Current task schemas accept an optional `model` selector or selector array on
each `tasks[]` item, or on a flat single-task call—not on the batch container.
Agent model overrides, definition frontmatter and inherited session models also
feed model selection. At `before_subagent_spawn`, undefined `modelRole` denotes
a non-role selector and is preserved with `respectExplicitModel: true`. Generic
`task`/`default` roles and aliases matching configured tier IDs remain routable;
all other role aliases are preserved. This applies even when `@task` was supplied
explicitly, or its role mapping expands to a concrete model: the hook preserves
role identity, not request-level explicitness. Setting `respectExplicitModel`
to false allows replacement of protected selections. The enable/disable command
and menu toggle change only `enabled`; disabled routing bypasses classification
regardless of this policy.

The router's policy is the single authority for preserving explicit selectors;
no second config helper interprets undefined roles differently.