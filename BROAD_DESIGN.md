EXECUTION MODE
==============

Treat this specification as a complete project brief.

You are the lead engineer responsible for taking the project from research
through a working, tested implementation.

Use OMP task delegation aggressively where it is useful. Delegate bounded,
well-defined research and implementation work rather than attempting to keep
the entire OMP codebase and project implementation in the root context.

You may run independent research tasks in parallel where appropriate.

However, YOU remain responsible for:
- architecture
- integration decisions
- reconciling subagent findings
- reviewing delegated code
- ensuring the implementation matches this specification
- running the final tests
- validating the extension against the actual current OMP implementation

Proceed through:

1. OMP API/source research
2. integration notes
3. architecture/design
4. minimum vertical slice
5. tests
6. settings/UI
7. session decision history
8. `/task-router test`
9. hardening
10. documentation/package preparation
11. final end-to-end validation

Do not stop after producing the research/design documents unless you discover
a genuine OMP API blocker requiring a design decision from me.

If an assumption in this specification is incorrect, prefer the behavior of
the current OMP source, document the discrepancy, and adapt the design.

When delegating, give subagents narrow tasks with explicit expected outputs.
Do not delegate architectural ownership.

At completion, provide:
- implementation summary
- important OMP integration findings
- files added/changed
- tests executed and results
- known limitations
- any upstream OMP changes that would improve the extension
- exact instructions for linking/installing and testing the plugin locally
- 

You are working on a new open-source plugin/extension for Oh My Pi (OMP), the
can1357/oh-my-pi project:

https://github.com/can1357/oh-my-pi

The project should provisionally be called:

    omp-task-router

GOAL
====

Build a small, focused OMP extension that intelligently chooses the model used
for OMP `task` subagents.

The extension should classify each delegated task into a configurable routing
tier and map that tier to an OMP model/modelRole.

It must NOT replace OMP's existing:
- modelRoles
- fallbackChains
- model resolution
- thinking/effort mapping
- provider configuration

The extension should only answer:

    "What model tier should this delegated task use?"

OMP should remain responsible for:

    "What concrete model does that role resolve to, what are its fallbacks,
     and what reasoning level should be used?"

Before implementing anything, inspect the CURRENT OMP source and documentation.
Do not assume API names or behavior from this prompt if the current source
disagrees.

Important: this is can1357/oh-my-pi. Do not accidentally use documentation for
another project called OMP, oh-my-pi, or OpenCode.


============================================================
1. DESIRED ARCHITECTURE
============================================================

Conceptually:

                    OMP task()
                        |
              +---------+----------+
              |                    |
            task             solutionSpace
              |                    |
              +---------+----------+
                        |
                        v
                 classifier model
                        |
                        v
                 routing tier
                        |
              +---------+---------+
              |         |         |
            cheap     normal     hard
              |         |         |
              v         v         v
       @task_cheap    @task    @task_hard
              |         |         |
              +---------+---------+
                        |
                        v
                  OMP resolves
             model + fallback chain


Meanwhile:

    task.effort --------------------------------> OMP

The router MUST NOT rewrite `effort`.

Model selection and reasoning-effort selection are deliberately separate.


============================================================
2. TASK INTERCEPTION
============================================================

We need to intercept OMP's `task` tool BEFORE the subagent is spawned.

Research the current OMP extension API and task implementation.

Our previous investigation suggested that the general `tool_call` extension
hook can inspect/revise task tool input before execution, while
`before_subagent_spawn` does not expose enough semantic information.

Do NOT trust that blindly.

Verify this against current source.

Find:

1. The implementation of the `task` tool.
2. Its actual input schema.
3. Extension hooks invoked before execution.
4. Whether tool input can be modified by an extension.
5. The exact model override field supported by `task`.
6. Model resolution precedence.
7. Whether modelRoles such as `@task_hard` are accepted as task model
   overrides.
8. Whether arrays/fallback model specifications are supported there.
9. What `before_subagent_spawn` currently exposes.
10. Whether there is a cleaner/newer hook specifically intended for this.

Document the findings before choosing the interception implementation.

Expected useful task information is approximately:

    task
    solutionSpace
    effort
    agent
    model
    context

but use the ACTUAL current schema.

The classifier should primarily receive:

    task
    solutionSpace

Other metadata may be supplied if useful, but avoid feeding huge contexts to
the classifier.


============================================================
3. SOLUTION SPACE
============================================================

`solutionSpace` is particularly important.

It describes how constrained/open-ended the problem is rather than simply how
much work there is.

Examples:

Very constrained:
    "one fix: rename, names given"

Known solution:
    "one fix: slice end in paginate"

Moderate reasoning:
    "single-flight cache load; races easy to miss"

Several viable designs:
    "several retry API shapes; error classes to choose"

Highly open-ended:
    "deadlock cause open, no repro"

A task affecting 100 files may still have a tiny solution space.

A five-line concurrency bug with unknown cause may have a huge solution space.

The classifier should therefore reason primarily from:

    task + solutionSpace

rather than assuming task size == task difficulty.


============================================================
4. EFFORT MUST REMAIN UNTOUCHED
============================================================

This is a hard design requirement.

OMP already has thinking/effort handling.

If task input contains something equivalent to:

    effort: low
    effort: medium
    effort: high
    effort: auto

or whatever the CURRENT OMP API supports, preserve it exactly.

The router chooses:

    MODEL

OMP chooses:

    MODEL-SPECIFIC REASONING LEVEL

Do NOT map:

    hard task -> high reasoning

inside this extension.

A task could legitimately route to a stronger model while retaining low
effort, or route to a cheaper model with high effort.

If OMP's automatic effort mapper uses solutionSpace, preserve that behavior.


============================================================
5. CONFIGURABLE TIERS
============================================================

Do NOT hard-code exactly three tiers internally.

The extension should support arbitrary user-defined tiers.

Example default configuration:

    tiers:
      cheap:
        model: "@task_cheap"

      normal:
        model: "@task"

      hard:
        model: "@task_hard"

The classifier returns a tier ID:

    cheap
    normal
    hard

The routing engine maps that to the configured model/modelRole.

Someone else should be able to configure:

    local
    cloud
    frontier

or:

    tiny
    standard
    coding
    reasoning
    frontier

without changing extension code.

Tier IDs should therefore be data, not an enum baked into the implementation.


============================================================
6. MODEL ROLES, NOT CONCRETE MODELS
============================================================

The preferred setup is:

    cheap  -> @task_cheap
    normal -> @task
    hard   -> @task_hard

OMP config remains responsible for concrete models, for example:

    modelRoles:
      task_cheap: ...
      task: ...
      task_hard: ...

Do not duplicate OMP's model configuration system.

However, if current OMP APIs naturally support selecting concrete models too,
allow them as an optional configuration value.

The router should not care whether the target is Ollama, OpenAI Codex,
Anthropic, etc.


============================================================
7. CLASSIFIER
============================================================

The classifier model itself must be configurable.

For my initial configuration I am considering something small/cheap such as:

    @tiny

which may resolve to something like an Ollama-hosted gpt-oss:20b.

Do not hard-code that model.

Configuration should support something conceptually like:

    classifier:
      model: "@tiny"
      prompt: |
        <user configurable classifier prompt>

The extension should use OMP's own model/provider infrastructure if reasonably
possible.

Avoid implementing an independent OpenAI-compatible HTTP client unless the
OMP extension APIs make using OMP's provider/model machinery impossible.

Research how extensions can invoke a model directly without creating another
normal agent turn.

We want:
- existing OMP provider credentials
- existing provider configuration
- model aliases/roles if supported
- no separate API-key management
- minimal token use
- structured classifier output

Determine the best supported OMP API for this.


============================================================
8. CLASSIFIER OUTPUT
============================================================

Use structured output if OMP/model APIs support it reliably.

Conceptually:

    {
      "tier": "normal",
      "reason": "Known implementation direction but several edge cases"
    }

Only `tier` controls routing.

`reason` is for observability/debugging.

Validate that:

    tier IN configuredTierIds

Never blindly trust classifier output.

If output is malformed, unavailable, times out, references an unknown tier,
or classification otherwise fails:

    use configured defaultTier

Classification failure MUST NOT prevent the task from running.


============================================================
9. CLASSIFICATION PROMPT
============================================================

The classification prompt must be completely user-configurable.

Provide a sensible default.

The default prompt should explain that the classifier must select the MINIMUM
model capability required to reliably complete the delegated task.

It should consider:

- ambiguity
- openness of solution space
- architectural reasoning
- cross-cutting implications
- debugging uncertainty
- concurrency/distributed-system complexity
- amount of judgment required
- whether the task is mechanical
- whether the implementation direction is already known

It should NOT equate:
- number of files
- number of lines
- verbosity of task description

with difficulty by themselves.

The prompt must dynamically include the configured tiers.

Do not write a prompt permanently tied to cheap/normal/hard.


============================================================
10. MANUAL MODEL OVERRIDES
============================================================

Research how OMP distinguishes an explicitly selected model from an
automatically/default selected model for `task`.

Desired behavior:

If the caller/user explicitly requested a model for this task, DO NOT silently
override it.

Manual selection wins.

For example:

    task(..., model="@foo")

should normally bypass routing.

However, verify whether task agents/defaults also populate `model`, because we
must distinguish:

    explicit user/model request

from:

    inherited/default model

if OMP provides that distinction.

If OMP does not expose enough information to distinguish these safely,
document the limitation and choose the least surprising behavior.

Make this behavior configurable if useful:

    respectExplicitModel: true


============================================================
11. RECURSION / CLASSIFIER SAFETY
============================================================

Prevent the classifier call itself from triggering task routing recursively.

Consider:
- reentrancy guards
- invocation metadata
- classifier model calls triggering extension hooks
- nested task agents

Routing should apply to actual `task` delegation, not to the internal
classifier invocation.


============================================================
12. CACHING
============================================================

Consider a small in-memory classification cache.

Cache key could be based on normalized:

    task
    solutionSpace
    classifier configuration

This is optional for v1.

Do not introduce a database.

Keep the extension lightweight.


============================================================
13. SETTINGS / UI
============================================================

Research the current OMP extension UI APIs.

We want an interactive command such as:

    /task-router

or:

    /routing

It should provide a small settings UI where possible.

Desired settings:

    Enabled                 yes/no

    Classifier model        @tiny

    Default tier            normal

    Respect explicit model  yes

    Tiers
      cheap                 @task_cheap
      normal                @task
      hard                  @task_hard

    Classification prompt
      [editable multiline text]

Ideally allow:

- add tier
- remove tier
- rename tier
- change mapped model/modelRole
- choose default tier
- edit classifier model
- edit classifier prompt
- enable/disable router
- save
- cancel

Research what `ctx.ui` currently supports.

Use native OMP UI primitives rather than inventing a separate web UI.

If multiline editing or complex settings forms are awkward in current OMP,
build the best clean UX possible and document the limitation.

Also provide command-line/subcommands if useful, e.g.:

    /task-router status
    /task-router enable
    /task-router disable
    /task-router test
    /task-router reload

Do not overbuild this initially.


============================================================
14. CONFIGURATION STORAGE
============================================================

Research OMP conventions for extension/plugin configuration.

Do not invent a storage location until you inspect existing extensions.

We need persistent user configuration.

Potential conceptual config:

    enabled: true

    classifier:
      model: "@tiny"
      prompt: |
        ...

    defaultTier: normal

    respectExplicitModel: true

    tiers:
      cheap:
        model: "@task_cheap"
      normal:
        model: "@task"
      hard:
        model: "@task_hard"

Prefer YAML if that matches OMP conventions; otherwise use the native
convention.

Provide:
- schema validation
- useful errors
- sensible defaults
- atomic writes if we write config ourselves

Invalid configuration should not break OMP startup.

============================================================
15. SESSION ROUTING DECISION HISTORY
============================================================

Routing decisions must be observable.

Maintain an IN-MEMORY, SESSION-SCOPED history of every routing decision made
by the extension.

This is not generic application logging. It is a structured decision history
whose purpose is to let the user inspect and evaluate the router's behavior.

The history:
- exists only for the current OMP session
- is cleared when the session ends
- requires no database
- requires no persistent telemetry
- should be bounded to prevent unbounded memory growth
- default maximum could be ~100 decisions, but make this configurable if
  trivial

Each decision should record structured data approximately like:

    {
      timestamp,
      taskPreview,
      solutionSpacePreview,

      classifierModel,
      classifierTier,
      classifierReason,

      selectedTier,
      mappedModel,

      existingModel,
      explicitModelOverride,

      effort,

      classificationLatencyMs,

      outcome,
      fallbackReason
    }

Use the actual terminology/types appropriate to OMP.

Important distinctions:

    classifierTier
        What the classifier returned.

    selectedTier
        What the router ultimately selected.

These may differ, for example if the classifier returned an invalid tier and
the router fell back to defaultTier.

Likewise:

    mappedModel
        The configured model/modelRole associated with selectedTier.

Do NOT mutate or reinterpret `effort`; record it only for visibility.


============================================================
15.1 DECISION OUTCOMES
============================================================

Record decisions even when routing is bypassed or fails.

Example outcomes:

    routed
    router_disabled
    explicit_model_preserved
    classifier_failed
    classifier_timeout
    invalid_classifier_output
    unknown_tier
    default_tier_used
    no_mapping
    task_left_unchanged

Prefer a typed outcome rather than arbitrary strings if practical.

For failures/fallbacks record a short reason.


============================================================
15.2 HISTORY COMMAND
============================================================

Expose the current session's decisions through the extension command.

Preferred UX:

    /task-router history

It should display a concise list such as:

    #  Time      Tier     Model          Eff


============================================================
16. DRY-RUN / TEST COMMAND
============================================================

A very useful feature would be:

    /task-router test

Allow entering:

    task
    solutionSpace

and show:

    selected tier
    mapped model role
    classifier reason

WITHOUT spawning a task.

This will make prompt/tier tuning much easier.

Prioritize this if the OMP UI makes it straightforward.


============================================================
17. FAILURE BEHAVIOR
============================================================

Routing must be fail-open.

If anything goes wrong:

- classifier provider unavailable
- classifier timeout
- malformed output
- invalid tier
- extension exception
- config problem

the original task should still run.

Preferred behavior:

    classifier failure
           |
           v
       defaultTier
           |
           v
       normal OMP task execution

If even defaultTier configuration cannot resolve safely, leave the task model
untouched and allow OMP's normal behavior.

Never turn model routing into a single point of failure.


============================================================
18. FALLBACK CHAINS
============================================================

Do NOT implement our own provider/model fallback system.

Once we choose:

    @task_hard

OMP should resolve that through its existing modelRole and fallback machinery.

Verify exactly how this works in current OMP.

If injecting a modelRole bypasses fallbackChains for some reason, STOP and
document that before designing around it.

Preserving OMP fallback behavior is a major requirement.


============================================================
19. PRIOR ART
============================================================

Inspect existing routing work before implementation.

In particular investigate:

    @pk/llm-router-agent

and its source in the relevant OMP ecosystem/repository.

We have seen concepts there such as:

    assignment
       -> classifier
       -> light | mid | heavy
       -> model tier

It also appears to contain:
- task-spawn routing policy
- model profiles
- quality/cost/latency scoring
- telemetry
- validation

We DO NOT want to copy that entire architecture.

Use it as prior art.

Things potentially worth borrowing:
- respecting manual model selection
- graceful routing failure
- minimum capability constraints
- classifier validation

Our extension should remain much smaller and OMP-native.

Also search the current OMP repository/issues/packages for any newer routing
extension or API that supersedes this approach.

If an existing maintained extension already solves essentially this exact
problem, report that before duplicating it.


============================================================
20. PACKAGE / PLUGIN STRUCTURE
============================================================

Although the core functionality is an OMP extension, structure the repository
so it can be distributed as an OMP plugin/package.

Research CURRENT plugin manifest conventions.

Expected conceptually:

    omp-task-router/
      package.json
      README.md
      LICENSE
      src/
        index.ts
        router.ts
        classifier.ts
        config.ts
        ui.ts
        types.ts
      tests/
        ...

Do not create unnecessary abstractions merely to match this structure.

The plugin manifest should expose the extension entry point according to
current OMP conventions.

During development it should be possible to use something equivalent to:

    omp plugin link ...

Verify the actual current command.

Eventually users should be able to install the package through OMP's normal
plugin mechanism.


============================================================
21. TYPESCRIPT
============================================================

Use TypeScript.

Follow OMP's current extension examples and package conventions.

Prefer:
- strict typing
- small modules
- dependency-light implementation
- OMP's existing dependencies/utilities where appropriate

Avoid adding a framework.

Avoid unnecessary runtime dependencies.


============================================================
22. TESTING
============================================================

Tests should cover at least:

1. constrained task -> configured lower tier
2. open-ended task -> configured stronger tier
3. arbitrary user-defined tier names
4. malformed classifier response -> default tier
5. unknown classifier tier -> default tier
6. classifier timeout/failure -> default tier
7. router disabled -> task unchanged
8. explicit model selection -> preserved
9. effort value -> EXACTLY preserved
10. solutionSpace -> included in classifier request
11. task -> included in classifier request
12. mapped model/modelRole -> injected correctly
13. no recursive routing of classifier invocation
14. invalid config -> safe behavior
15. no tier/model mapping -> safe behavior

Most importantly, add a regression test proving:

    input.effort === output.effort

for every routing path.

We do not want this extension taking ownership of reasoning effort.


============================================================
23. README
============================================================

Write a useful README explaining the philosophy.

The key distinction is:

    Task Router chooses MODEL CAPABILITY.
    OMP chooses REASONING EFFORT.

Explain why solutionSpace is useful.

Example:

    task:
      "Rename the authentication helper across all packages"

    solutionSpace:
      "Mechanical rename; exact old and new names provided"

Even if this touches 100 files, it can route cheaply.

Versus:

    task:
      "Fix intermittent deadlock in worker shutdown"

    solutionSpace:
      "Cause unknown; multiple synchronization paths; no reliable repro"

Even if the eventual patch is five lines, it may deserve the strongest tier.

Include:
- installation
- configuration
- UI/commands
- tier examples
- classifier prompt customization
- modelRole examples
- fallback behavior
- manual override behavior
- debugging/testing instructions


============================================================
24. IMPLEMENTATION PROCESS
============================================================

Do NOT immediately write the whole extension.

Work in phases.

PHASE 1 — RESEARCH

Inspect current OMP source and produce:

    docs/omp-integration-notes.md

Document with source paths/symbol names:

- extension loading
- plugin packaging
- tool_call hook
- task implementation
- task input schema
- model override behavior
- modelRole resolution
- fallbackChain interaction
- effort handling
- solutionSpace handling
- extension UI APIs
- model invocation API available to extensions
- config conventions
- relevant existing router implementations

Call out any assumptions in this prompt that are wrong or outdated.

PHASE 2 — DESIGN

Produce:

    docs/design.md

Keep the design intentionally small.

Show:
- interception point
- classifier invocation
- tier resolution
- model injection
- effort preservation
- failure path
- recursion protection
- config lifecycle
- UI lifecycle

Do not implement until the design is consistent with actual OMP APIs.

PHASE 3 — MINIMUM VERTICAL SLICE

Implement only:

    task intercepted
       ->
    classify task + solutionSpace
       ->
    tier
       ->
    configured modelRole
       ->
    task proceeds

with:
- config
- fail-open behavior
- effort preservation

Prove this works before building UI.

PHASE 4 — UI

Add `/task-router` configuration/status/test UX.

PHASE 5 — HARDENING

Add:
- tests
- validation
- recursion protection
- bounded history
- docs
- packaging


============================================================
25. IMPORTANT DESIGN PRINCIPLES
============================================================

Keep these principles throughout:

1. OMP-native over custom infrastructure.

2. Tier routing over concrete provider routing.

3. Configurable policy over hard-coded opinions.

4. solutionSpace is a first-class classifier signal.

5. Model capability and reasoning effort are orthogonal.

6. Explicit user choice wins.

7. Classification failure must not break task execution.

8. Existing OMP modelRoles/fallbackChains remain authoritative.

9. No separate telemetry/cost platform.

10. Keep the extension small enough that its behavior is easy to understand.

11. Avoid modifying OMP core if the public extension API can accomplish the
    goal.

12. If OMP's extension API is missing one small capability, identify the
    smallest upstream API change required rather than introducing a large
    workaround.


============================================================
26. FIRST ACTION
============================================================

Start by researching the current can1357/oh-my-pi source.

Do NOT implement yet.

Return:

1. Exact OMP extension hooks/APIs we should use.
2. Exact task schema relevant to routing.
3. How model overrides/modelRoles/fallbacks resolve.
4. How an extension should invoke the classifier model through OMP.
5. Available UI/config APIs.
6. Existing routing prior art.
7. Any blockers.
8. Recommended minimal architecture.

Then create `docs/omp-integration-notes.md` and `docs/design.md`.

Only after those findings are established should you begin the minimum
vertical-slice implementation.