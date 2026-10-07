# omp-task-router

**Small tasks. Small models. Hard problems. Heavy hitters.**

Stop sending every delegated task to your biggest model. Task Router is an
[Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) extension that reads a
task's goal and solution space, then chooses a configurable model tier.
Mechanical work can use your lightweight model; open-ended debugging can get
more capable machinery. You choose the models behind each tier.

**Task Router chooses model capability. OMP still chooses reasoning effort.**

## Why use it?

- **Match the model to the problem.** Route by ambiguity and reasoning demands,
  not file count or task length.
- **Bring your own lineup.** Use OMP role aliases or concrete model patterns;
  rename or add tiers without changing code.
- **Keep control.** Explicit model selections are preserved by default. OMP's
  reasoning effort and retry-fallback machinery stay in charge.
- **See the decision.** Inspect the selected tier, mapped model and classifier
  reason, or try a task without spawning an agent.
- **Keep tasks moving.** Classification failures fall back to your default
  tier. Unsafe routing leaves OMP's original model choice untouched.

## Get started

Install into an existing OMP setup:

```sh
omp plugin install https://github.com/sdananjay/omp-task-router.git
```

For a local checkout instead:

```sh
omp plugin link /path/to/omp-task-router
```

Restart OMP to load the extension. The defaults use these OMP roles:

| Tier | Default model | Typical fit |
| --- | --- | --- |
| `cheap` | `@tiny` | Mechanical changes with a clear recipe |
| `normal` | `@task` | Scoped implementation with a known approach |
| `hard` | `@slow` | Ambiguous debugging and consequential design choices |

Model availability and credentials come from your OMP configuration. Tier
selection is a model judgment, not a fixed rule or a correctness guarantee.

Delegate a task, then use `/task-router history` to inspect its routing.
`/task-router` opens the menu; `/task-router test` lets you tune routing without
launching another agent. Commands initialize after the first task spawn that
can be safely correlated; until then, they report `not initialized`.

## A hundred files can be easy. Five lines can be hard.

The classifier considers both `task` and `solutionSpace`: the goal **and how
open-ended the route to a solution is**.

```yaml
task: Rename the authentication helper across all packages
solutionSpace: Mechanical rename; exact old and new names provided
```

A large diff with a clear recipe is a candidate for **cheap**.

```yaml
task: Fix intermittent deadlock in worker shutdown
solutionSpace: Cause unknown; multiple synchronization paths; no reliable repro
```

A tiny eventual patch can still call for **hard**. The default prompt asks for
the minimum tier capable of completing the task reliably, leaning toward
capability when uncertain.

## Your tiers, your models

Defaults work without creating an extension config file. To customize them,
use the menu or edit `~/.omp/task-router/config.json` (created on first save).
If `XDG_CONFIG_HOME` is set, the path is `$XDG_CONFIG_HOME/task-router/config.json`.

```json
{
  "enabled": true,
  "classifier": {
    "model": "@tiny",
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

Want `local`, `cloud`, and `frontier` instead? Those are just tier IDs. Each
`model` accepts an OMP role alias or model pattern. Point `hard` at a dedicated
role, for example:

```yaml
# ~/.omp/agent/config.yml
modelRoles:
  task_hard: openai-codex/gpt-6.1-sol:high
```

Then set the extension's `tiers.hard.model` to `@task_hard`.

Omit `classifier.prompt` to keep the default prompt, or edit it with
`/task-router prompt`. Custom prompts use `{tiers}` to insert the configured
tier IDs. After manual config changes, use `/task-router reload`.

### Does `respectExplicitModel: true` stop routing?

**No. Ordinary `@task` delegations are still routed.** The setting protects
specific model choices, not the generic task role. It defaults to `true`.

For safely correlated task spawns while routing is enabled:

| Model selection | With `respectExplicitModel: true` |
| --- | --- |
| Inherited `@task` or `@default` | Classify and route |
| `modelRoles.task` points to a concrete model | Classify and route; the role is still `task` |
| Task explicitly passes `"model": "@task"` or `"@default"` | Classify and route |
| Task selects a concrete model or pattern | Preserve the selection; skip classification |
| Selected role matches a configured tier ID, such as `@hard` | Classify and route |
| Any other role alias, such as `@smol` | Preserve the selection; skip classification |

OMP accepts an optional `model` selector on each `tasks[]` item (or on a flat
single-task call). The parent agent supplies it when constructing the task:

```json
{
  "context": "Investigate the shutdown deadlock.",
  "tasks": [{
    "name": "debug-shutdown",
    "task": "Find the cause of the worker shutdown deadlock.",
    "solutionSpace": "Unknown cause; inspect synchronization paths.",
    "model": "openai/gpt-5.4"
  }]
}
```

With the default setting, that concrete selection is preserved. Agent model
definitions and per-agent overrides can also supply a protected selection.
The policy checks the effective role, not whether a `model` argument was
explicitly supplied; generic and tier-named roles remain routable either way.

Set `respectExplicitModel` to `false` to allow routing to replace protected
model selections too. **The on/off toggle changes `enabled` only**—it never
changes `respectExplicitModel`. When `enabled` is `false`, automatic routing
is bypassed regardless of the explicit-model setting.

## Inspect, test, tune

| Command | What it does |
| --- | --- |
| `/task-router` | Open the interactive menu |
| `/task-router status` | Show the current configuration and history count |
| `/task-router history` | Show recent routing decisions |
| `/task-router test` | Classify a task and solution space without spawning an agent |
| `/task-router prompt` | Edit the classifier prompt |
| `/task-router tiers` | Edit tiers and model mappings |
| `/task-router enable` / `/task-router disable` | Toggle routing |
| `/task-router reload` | Reload the config file |

History is in-memory and session-scoped. Correlated decisions include the tier,
model, effort, outcome and task preview. Test output also shows the classifier
reason when one is supplied.

## How it works—and where it stays out of the way

For a safely correlated task spawn, the extension:

1. Captures the task text without changing tool arguments.
2. Calls the classifier through OMP's `completeSimple`, with reasoning disabled
   and a small output budget.
3. Maps the returned tier to your chosen model and returns it through OMP's
   `before_subagent_spawn` hook. OMP handles model resolution and retry fallbacks.

The classifier adds a provider request on a cache miss. Cached classifications
include task, solution space, classifier model/prompt and ordered tier IDs.
Changing a model mapping reuses the classification; changing tier IDs
reclassifies.

### Safety and current limits

- **Concrete model selectors and non-generic, non-tier role aliases are
  preserved** when `respectExplicitModel` is enabled; generic `@task`/`@default`
  and tier-named roles remain routable, as described above.
- **Classifier failure, timeout or unusable output** uses `defaultTier`; an
  unresolvable fallback leaves OMP's original model in place.
- **Malformed config disables routing** rather than silently rerouting tasks.
- **Correlation never relies on FIFO order or names alone.** Entries are matched
  by tool-call ID/index or progress-bound agent IDs. Rejected and failed calls
  purge their pending text; missing or ambiguous keys leave the spawn untouched.
- **Not every spawn can be routed yet.** Named synchronous and early speculative
  launches without a progress-bound ID keep OMP's model. Complete coverage needs
  origin call ID and batch index in OMP's spawn event. Eval `agent()` spawns are
  also left untouched.

The extension does not rewrite `task.effort`, your model-role definitions, or
retry-fallback settings.

## Development

```sh
bun install
bun test
bunx tsc --noEmit
bun run tests/lifecycle.test.ts --smoke
```

The lifecycle test and standalone smoke use actual OMP SDK sessions, TaskTool
execution and child agents with a local scripted inference provider.

For implementation details, see [the design](docs/design.md),
[OMP integration notes](docs/omp-integration-notes.md), and
[prior art](docs/prior-art.md).
