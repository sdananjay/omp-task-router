# omp-task-router design

Small, OMP-native. Picks the MODEL CAPABILITY for delegated `task` agents via
a cheap classifier. OMP keeps effort selection, role resolution, fallback
chains — untouched.

## Interception point

`before_subagent_spawn` extension event (see omp-integration-notes.md §2b).
Rationale:
- Purpose-built routing seam, replaces `policy.modelOverride` / `modelRoute`.
  Verified `structured-subagent.ts::applySpawnHook` →
  `resolveConfiguredModelPatterns(result.model, settings)` → role aliases like
  `@task_hard` expand against `modelRoles`, and the preserved role identity keeps
  inherited retry-fallback chains working (executor.ts:263-269: role-keyed
  chain is preserved; when `modelOverride` supplied, child's chain comes from
  preserved `modelRole`).
- Fires exactly once per spawned child, in the parent session, before model
  resolution. One event = one routing decision.
- `tool_call` was rejected: the task wire schema (arktype `"+":"delete"`)
  has no passthrough `model` field and stripped keys can't reach spawn model
  resolution (notes §2a).

Event gives `agent`, `invocationKind`, `modelRole`, `patterns`, `spawnKey`.
It does NOT give task/solutionSpace text. To classify we need it — get it
from the `tool_call` event on `task`, which carries the raw input.

### Two-event pairing

- `tool_call` (toolName === "task"): stash flat `task`/`solutionSpace` +
  batch `tasks[]` items, keyed on `toolCallId`; remember whether the input
  contained an explicit `model` key (it can't — schema has none — but check
  `input` defensively; internal callers bypass arktype).
- `before_subagent_spawn`: pop pending classification input by matching spawn
  context. When the spawn has no matching stashed text (eval `agent()`,
  speculative launches that were adopted), record outcome
  `task_left_unchanged` and return undefined.

Batch mode: one `tool_call` may precede N `before_subagent_spawn` events with
per-item solutionSpaces. The event carries only `spawnKey` — the task tool
reserves ids; our pairing uses a FIFO queue per process keyed stashed items in
order. `ponytail:` heuristic — good enough for sequential scheduling; exact
batch-item ↔ spawn correlation is not exposed by OMP.

## Classification

- Config `classifier.model` (default `"@tiny"`), resolved via
  `ctx.models.resolve(spec)`; undefined → fail-open.
- Call: `completeSimple(model, { systemPrompt: [builtPrompt],
  messages: [user(taskText)] }, { apiKey:
  ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId()),
  disableReasoning: true, maxTokens: 256, signal })` — mirrors OMP's bundled
  annotate/text-summary.ts.
- Parse output: accept raw word or `{"tier": "...", "reason": "..."}` (strip
  fences, take last line if it parses as JSON, else trim to first word).
- Validate tier ∈ configured tiers; else outcome `unknown_tier` → defaultTier.
- Reentrancy: module-level boolean guard around classifier invocation; our
  classifier never calls `task`.
- Timeout: `AbortSignal.any([spawn signal, AbortSignal.timeout(cfg.classifierTimeoutMs=8000)])`;
  timeout → outcome `classifier_timeout` → defaultTier.
- Cache: Map keyed `sha256(taskText + "\n\u0000\n" + solutionSpace + classifier model+prompt fingerprint)`,
  capped at 256 entries (insertion-order evict). In-memory, per process.

## Routing

- Tiers: `Record<string, { model: string }>` from config; classifier tier id
  is just a key. Default config:
  ```json
  { "cheap": { "model": "@task_cheap" },
    "normal": { "model": "@task" },
    "hard":   { "model": "@task_hard" } }
  ```
- Result: `return { model: tier.model, note: "task-router:<tier> reason" }`.
- Missing tier mapping (`no_mapping`) or undefined resolved patterns →
  leave input untouched (`task_left_unchanged`).
- `modelRole !== undefined && cfg.respectExplicitModel` → only bypass when the
  role came from an **explicit** source. Distinguishing explicit from
  inherited: `modelRole === "default"` or `modelRole === "task"` where the
  agent definition ships `model: "@task"` are indistinguishable from user
  selection at this event; OMP does not expose request-level explicitness
  (notes §6). Decision: route everything whose `modelRole` is undefined or in
  {`task`,`default`} (the inheritance defaults for the generic task agent),
  bypass when `patterns`/`modelRole` indicate any other explicit alias.
  Configurable via `respectExplicitModel`.
- Session model override (`--model`): `applySpawnHook` does NOT consult it for
  patterns that came from agent defaults, so neither do we.

## Effort

Never touched. The event/result carries no effort field; we return only
`model` + `note`. Regression test asserts classifier failure paths leave the
spawn untouched (no result returned = no mutation).

## Config

`~/.omp/task-router/config.json` (JSON to match omp-plugins.lock.json
conventions; YAML only for OMP core settings):

```json
{
  "enabled": true,
  "classifier": {
    "model": "@tiny",
    "prompt": "…default classification prompt…",
    "timeoutMs": 8000,
    "cache": true
  },
  "defaultTier": "normal",
  "respectExplicitModel": true,
  "tiers": {
    "cheap":  { "model": "@task_cheap" },
    "normal": { "model": "@task" },
    "hard":   { "model": "@task_hard" }
  }
}
```

Loaded lazily per session start + on `/task-router reload`; schema-validated
(missing/extra keys tolerated, unknown tier refs warn, invalid config →
disable router + notify once; never break OMP startup: top-level try/catch
in factory).

## History

In-memory per session (`Extension` instance state is rebound per session;
store in a WeakMap keyed by the runner's `ctx.sessionManager.getSessionId()`),
capped 200 entries, FIFO. Records:
`{ ts, taskPreview, solutionSpacePreview, classifierModel, classifierTier,
classifierReason, selectedTier, mappedModel, modelRole, patterns, effort,
latencyMs, outcome, fallbackReason }`.
Outcomes (typed union): `routed | router_disabled | explicit_model_preserved |
classifier_failed | classifier_timeout | invalid_classifier_output |
unknown_tier | default_tier_used | no_mapping | task_left_unchanged`.

## UI (commands)

Single `/task-router` command, subcommand-style (ponytail pattern):
- (no args) → interactive menu: `select` between Status / Enable / Disable /
  History / Test / Edit prompt / Edit tiers / Reload.
- `status` — enabled, classifier model, tiers, default tier.
- `enable` / `disable` — writes config.
- `history` — notify() with compact table of last N decisions:
  `# Time Tier Model Eff Outcome`, plus last classifier reason.
- `test` — `input()` task, `input()` solutionSpace, run classifier, notify
  tier + mapped model + reason. No spawn.
- `prompt` — `ui.editor()` for the classification prompt.
- `tiers` — `ui.editor()` for the full JSON config (single editor covers tier
  add/remove; per-field forms would need custom components — document this).
- `reload` — re-read config.

Non-interactive (`ctx.hasUI === false`): `notify`-only, or plain text output
via pi.logger for /print mode.

## Package

```
omp-task-router/
  package.json    { name, version, "omp": { "extensions": ["./src/index.ts"] } }
  README.md LICENSE tsconfig.json
  src/index.ts        — factory: register command + hooks, wiring
  src/config.ts       — load/validate/save config
  src/router.ts       — state machine: classify→tier→model, history
  src/classifier.ts   — completeSimple wrapper + parser + cache
  src/ui.ts           — /task-router subcommands
  tests/*.test.ts     — bun:test
```

Deps: dev-only (`@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-ai`, `bun:test` —
types imported from the installed OMP runtime). Runtime deps: none.

## Failure behavior

Everything fail-open. Any throw in our handlers is caught; handler returns
undefined → OMP applies its own policy. Classification failure → defaultTier
mapping attempted; if that mapping missing/unresolvable → return undefined
(leave OMP default). The extension NEVER blocks a spawn.

## Testing

- `tests/effort.test.ts`: run router flow with fake classifier asserting
  result never contains effort fields; OMP's own effort parsing is unaffected
  because we don't return it.
- `tests/classify.test.ts`: parser word/JSON/fence/garbage cases; unknown tier
  → defaultTier.
- `tests/config.test.ts`: defaults, invalid config → disabled, tier add/remove.
- `tests/router.test.ts`: explicit-model bypass, cache hits, history outcomes.
- Integration: linked into ~/.omp plugins, run real `omp` session with a
  scripted prompt that spawns a task, verify resolved model in session log via
  `/task-router history`.