# `workbench/tests/` — lettered ordered-spec suite (sanctioned exception)

This directory is a documented, sanctioned exception to the repo's normal
test-colocation convention (a test file lives next to the source file it
covers). `workbench/` (the pane-split/drag/keyboard construct-validate-select
engine, renamed from `layout/` in the WP-ORG-2 organization pass) is instead
tested as one continuous, ordered behavior battery that spans the whole
engine rather than any single module in it.

## The A–N naming convention

Each file is prefixed with a capital letter (`A-hydration.test.ts` through
`N-reactivity.vitest.tsx`) that fixes its place in a deliberate read/run
order — earlier letters cover more foundational behavior (state hydration,
pane contents) that later letters build on (drag-drop, keyboard, full
end-to-end journeys, reactivity). The letter is a sequencing device, not a
priority or ownership marker: read the suite in order (A, B, C, …) to build
up the engine's behavior narrative the way the test authors intended.

Two files have no letter prefix because they are shared test infrastructure
consumed by the lettered specs, not specs themselves:

- `dom-helpers.tsx` — DOM/mount test helpers.
- `state-harness.ts` — shared `WorkbenchState` construction/fixture helpers.

Both are intentionally excluded from the production import graph and from
orphan-module detection (see `src/architecture/import-graph.guard.test.ts`'s
`keeps test-support helpers outside the production import graph` case,
which pins their paths under `claxedo-ui/workbench/tests/`).

## Why this directory exists instead of flat colocation

`src/claxedo-ui/state/tests/` (the sibling exception this repo used to have)
was flattened during the WP-ORG-2 pass because its three files each had a
single, obvious subject file to colocate next to. `workbench/tests/` is
different: the lettered suite is a cross-cutting behavior narrative over the
whole engine (construct + drag-drop + keyboard + selectors + validate +
provider together), not a one-to-one test-to-module mapping, so there is no
single sibling file for any given letter to colocate with. Keeping the suite
in its own `tests/` directory, in order, is the intentional shape — do not
flatten it as part of a future colocation pass without re-confirming this
reasoning still holds.

## Adding a new spec here

Only add a new lettered file if it belongs in the same continuous ordered
narrative (i.e., it depends on state established by earlier letters and
would confuse a reader if filed elsewhere). Anything that tests one
`workbench/` module in isolation, with no dependency on the ordered story,
should be a normal colocated `*.test.ts`/`*.vitest.tsx` sibling directly in
`workbench/` instead — do not default new tests into this directory just
because it is the local convention.
