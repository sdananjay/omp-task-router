# Prior art (routing in OMP ecosystem)

## @mcowger/llm-router-agent (GitHub)
- Intercept via `input`/`tool_use` events; decided per spawn.
- Classifier: OpenAI-compatible endpoint, one-word label (`light`/`mid`/`heavy`), fixed system prompt; any error (HTTP, parse, timeout) → fallback tier with `source: "fallback"`, never fails the task.
- Tier mapping via config `taskSpawn.labelMappings` (default `frontier` for heavy); no match → preserves the candidate set (fail-open).
- Explicit model respected: `try-set-model` mode applies router choice only when the user hasn't selected a model.
- Config loaded from multiple candidate paths, merged with defaults, normalized, validated.
- Notable gaps we avoided: no reentrancy guard on its own HTTP classifier, no per-decision history surface, no bypass lists.

## @oh-my-pi/snapcompact (installed)
- Nested config shapes with runtime validation and per-provider families — evidence that config validation belongs at load, failure → warn + disable that feature, not crash.

## @dietrichgebert/ponytail (installed)
- `pi.registerCommand` with subcommand strings parsed in the handler; `ctx.ui.notify` for output; config persisted via plain JSON under a stable dir; session-scoped state via `pi.appendEntry`.
- Borrowed: single command + subcommands, notify-based feedback, JSON config file.