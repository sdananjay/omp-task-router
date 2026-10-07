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
  resolution. A uniquely correlated event produces one routing decision.
- `tool_call` observes inputs only. Current OMP supports an explicit `model`
  selector; routing uses the spawn hook without rewriting tool arguments.

Event gives `agent`, `invocationKind`, `modelRole`, `patterns`, `spawnKey`.
It does NOT give task/solutionSpace text. To classify we need it — get it
from the `tool_call` event on `task`, which carries the raw input.

### Lifecycle correlation

- `tool_call` captures flat or batch text by call ID and original index;
  repeated events replace that call only. `tool_execution_start` refreshes
  executed arguments after other extensions and validation.
- `tool_execution_update` binds progress-row agent IDs to call/index.
- `before_subagent_spawn` consumes exactly one indexed or progress-bound key
  before its first await. Invocation order is irrelevant; labels that could
  impersonate another call/index are rejected as ambiguous.
- Approval rejection, error results and execution errors purge the call.
  Successful returns retain only pending/running background progress rows;
  turn end drops unbound leftovers, and session switch/shutdown clears all.

OMP chooses `spawnKey` from allocated ID, label, or `parentToolCallId:index`,
in that order. Labels alone cannot distinguish allocated IDs from input names.
Unmatched/ambiguous keys and eval spawns return undefined without classification.
Named synchronous and early speculative launches without progress binding
therefore retain OMP's model. Full coverage needs origin call ID/index on the
spawn event; no FIFO or name heuristic is used.

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
- The classifier calls a provider directly, never `task`; no reentrancy guard.
- Timeout: native `AbortSignal.timeout(classifier.timeoutMs)`, combined with
  an optional caller signal. Provider aborted responses and transport errors
  preserve the signal reason; timeout/abort → `classifier_timeout` → defaultTier.
  The spawn event does not expose its cancellation signal to the extension.
- Cache: Map keyed by JSON-encoded task, solution space, classifier model, full
  prompt and ordered tier IDs. Reload compares these configuration inputs;
  mapping-only changes retain classifications. Keys also isolate in-flight
  results from later configuration changes. Maximum 256 entries, insertion-order
  eviction, per extension factory.

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
- `enabled: false` bypasses automatic routing before classification. Commands
  and the menu toggle only `enabled`; they do not change `respectExplicitModel`.
- With `respectExplicitModel: true`, undefined `modelRole` denotes a concrete
  model/pattern selector and bypasses classification. Roles `task`, `default`,
  and roles matching configured tier IDs remain routable; all other roles
  bypass classification. The effective role is the authority, not the source
  of the selector: explicitly passing `model: "@task"` still permits routing,
  and mapping `modelRoles.task` to a concrete model does not make the task
  explicit. OMP does not expose request-level explicitness at this event
  (notes §6). With `respectExplicitModel: false`, these preservation bypasses
  are disabled, but `enabled` and safe correlation are still required.
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

Loaded on correlated spawns and `/task-router reload`. Missing keys use
defaults; malformed files disable routing. The spawn handler fails open.

## History

In-memory in the extension factory closure (rebound per OMP session),
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
  src/classifier.ts   — completeSimple wrapper + parser
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

- `tests/router.test.ts`: parser cases, explicit-model bypass, effort preservation,
  warm-cache behavior, tier renames and history outcomes.
- `tests/lifecycle.test.ts`: actual SDK sessions, agent loop, TaskTool, extension
  runner and child yield execution using a local scripted provider. Exercises
  rejection, preflight failure, reversed batch order, overlapping calls, queued
  background IDs after settlement, unsafe names and real provider
  timeout/abort/error responses.
- Standalone smoke: `bun run tests/lifecycle.test.ts --smoke` (no cloud requests).