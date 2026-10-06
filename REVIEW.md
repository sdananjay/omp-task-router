# Code Review Findings — RESOLVED (2026-10-06)

All findings addressed; regression tests added (`tests/router.test.ts`, 26 pass).

## P1 — Key stashed inputs by task call
**Fixed** (`src/index.ts`). Singletons replaced by a `pending` FIFO in `tool_call`
emission order, each entry keyed by `toolCallId` so streaming partial→final events
replace (not duplicate) their entries. Spawns dispatch sequentially per call and
calls in order, so spawn N pairs with entry N. Rejected calls leave text unconsumed.

## P1 — Preserve concrete explicit model selectors
**Fixed** (`src/router.ts::isExplicitModelPolicyPreserved`). Per OMP type contract,
`modelRole === undefined` = explicit selector → now preserved (`explicit_model_preserved`).
Covered by tests: both with `respectExplicitModel` true and false.

## P2 — Keep the cache across unchanged reloads
**Fixed** (`Router.reload(config, previous?)`). Cache cleared only when
classifier model/prompt changed; per-spawn config reload now keeps warm entries.

## P2 — Compare the selected menu action when enabling
**Fixed** (`src/ui.ts`). Compares `selected` (action value), not `choice` (label).
Enable/disable from the interactive menu now works.

## P2 — Parse a complete JSON classifier response
**Fixed** (`src/classifier.ts`). Whole-text `JSON.parse` attempted first
(covers pretty-printed multiline JSON), then single-line candidates, then bare word.
Tests for pretty-printed raw + fenced forms.

## P2 — Disable routing after invalid configuration
**Fixed** (`src/config.ts`). Unparseable `config.json` → returns `enabled: false`
plus error (fail-open: spawns run with OMP's own model choice until fixed).
Note: this is intentionally a bit of a false positive — the review said "instead
of failing open"; the original behavior WAS fail-open for the task (defaults, no
crash) but rerouted with defaults, which contradicts the spec's "if defaultTier
cannot resolve safely, leave untouched". Disabled-until-fixed is stricter and correct.
Also: invalid `defaultTier` (parse succeeded) now corrects to the first surviving tier
instead of warning-with-config-that-was.