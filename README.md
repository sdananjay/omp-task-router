# omp-task-router

OMP (Oh My Pi) extension that classifies delegated `task` tools into
configurable **model tiers** and remaps the subagent's model accordingly.

## Philosophy

**Task Router chooses MODEL CAPABILITY. OMP chooses REASONING EFFORT.**

The extension answers only: *"What model tier should this delegated task use?"*
Everything else — the concrete model behind a role alias, fallback chains,
reasoning level — stays with OMP (`modelRoles`, `retry.fallbackChains`,
`task.effort` are never touched or reinterpreted).

### Why `solutionSpace` matters

Task size ≠ difficulty. The classifier reasons primarily from `task` +
`solutionSpace` (how open-ended the work is):

```yaml
task: Rename the authentication helper across all packages
solutionSpace: Mechanical rename; exact old and new names provided
```
→ 100 files, still routes **cheap**.

```yaml
task: Fix intermittent deadlock in worker shutdown
solutionSpace: Cause unknown; multiple synchronization paths; no reliable repro
```
→ eventual patch may be five lines, routes **hard**.

## How it works

1. `tool_call` on `task` stashes the (unmodified) `task` + `solutionSpace` text.
2. `before_subagent_spawn` classifies via the configured classifier model
   (OMP's own `completeSimple` machinery, reasoning disabled, tiny budget),
   validates the tier against your configured tiers, and returns
   `{ model: "<tierModel>", note: "task-router: tier=…" }`.
3. OMP resolves the role alias through `modelRoles` + fallback chains as usual.

Failure is fail-open: classifier unavailable/timeout/unknown tier →
`defaultTier`; even that unresolvable → the spawn runs with OMP's own model
choice. Explicit model requests (`respectExplicitModel: true`) are never
overridden.

## Install

```sh
# development / local checkout
omp plugin link /path/to/omp-task-router
# or via git
omp plugin install <git-url>
```

## Configuration

`~/.omp/task-router/config.json` (created on first save):

```json
{
	"enabled": true,
	"classifier": {
		"model": "@tiny",
		"prompt": "<default prompt; {tiers} expands to the configured tier ids>",
		"timeoutMs": 8000,
		"cache": true
	},
	"defaultTier": "normal",
	"respectExplicitModel": true,
	"tiers": {
		"cheap":  { "model": "@tiny" },
		"normal": { "model": "@task" },
		"hard":   { "model": "@slow" }
	}
}
```

Tier ids are data — add `local`, `cloud`, `frontier`, whatever; no code changes.
Each tier's `model` is any model pattern or role alias OMP understands
(`@task_hard`, `openai-codex/gpt-5:high`, …).

Works out of the box with OMP's built-in roles (`@tiny`, `@task`, `@slow`).
Optionally add dedicated roles in `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  task_hard: openai-codex/gpt-6.1-sol:high   # or point tiers at any model id directly
```

## Commands

- `/task-router` — interactive menu (status/history/test/edit/reload)
- `/task-router status|enable|disable|history|test|prompt|tiers|reload`
- `test` asks for task + solutionSpace, runs the real classifier, and shows
  the tier/model/reason **without spawning a task** — for prompt and tier tuning.

## Decision history

Every routing decision (including bypasses and failures) is recorded in an
in-memory, session-scoped history — `/task-router history` shows tier, mapped
model, effort, outcome (`routed`, `explicit`, `cls-fail`, `timeout`,
`bad-tier`, `default`, …) and task preview.

## Development

```sh
bun install          # dev deps (types only)
bun test             # unit tests incl. effort-untouched regression
bunx tsc --noEmit    # strict typecheck
```

Sources: `src/index.ts` (hooks + wiring), `src/router.ts` (state machine,
history, cache), `src/classifier.ts` (OMP `completeSimple` call + output
parser), `src/config.ts` (load/save/validate), `src/ui.ts` (command UX).

Design docs: `docs/design.md`, `docs/omp-integration-notes.md` (verified OMP
API surface), `docs/prior-art.md`.