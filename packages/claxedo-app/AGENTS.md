# Claxedo app

This package is the Claxedo app. These rules apply to everything in it. The repo root `AGENTS.md` still applies; where the two differ, this file wins for this work.

## Today's server

The app runs on today's server contracts. `src/server/` is the only place that knows routes, payloads and event names, and `src/server/wire/` is the only place that uses the server's names. Everything else uses Claxedo types from `src/server/index.ts`. Do not change a server contract from this package's work.

## Access

- Every access question in the UI goes through `can()` in `src/access/`, which answers only from facts the server reports. Never re-derive a server rule in the app.
- "Permission" in code means an agent request, and lives in `src/session/requests/`. Access code never uses the word.

## Plugins

- First-party and user plugins get the same API. Add a primitive only when a plugin needs it, and add it to the plan's primitive table in the same change.
- User plugins run in the app's JavaScript on desktop, and in a sandboxed iframe on the web. Never give that iframe same-origin.

## No comments

Code carries no comments: no line comments, block comments, JSDoc, file headers, section banners or commented-out code.
- Names, types and small functions say what the code does.
- The domain's `README.md` says why: owned concepts, state machines, invariants, constraints.
- The end-to-end flows and the transcript corpus say how it behaves.

Directives a tool reads are not comments and stay, with no prose added: `// @ts-expect-error`, `// oxlint-disable-next-line <rule>`, `/* @vite-ignore */`, `/*#__PURE__*/`, `/// <reference …>`, shebangs, and generated-file markers.

## Files and folders

- One responsibility per file, and its name says what it owns. No `utils`, `helpers`, `common` or `misc` files or folders.
- A file stays under 300 lines, a function under 40 and a component under 120. Past that, split along responsibilities; never compress lines to fit.
- Organize by domain: keep the code for a product concept, such as sessions or files, together. Technical layers such as views, state, and API calls live inside that domain instead of in separate app-wide folders. A domain lives in `src/<domain>/` and has:
  - `model.ts`: types, events and state machines;
  - `store.ts`: state and actions;
  - `api.ts`: calls into `src/server/`;
  - `view/`: components;
  - `index.ts`: the domain's public surface;
  - `README.md`: owned concepts, machines, flows.
  - Folders go at most three levels deep.
- Import another domain only through its `index.ts`. Shared code lives in `src/lib/<concept>.ts` only when two or more domains use it; otherwise it lives with its one user.

## Names

- Use `camelCase` for variables, parameters, properties, and functions; `PascalCase` for types, classes, and components; and `kebab-case` for files and folders, such as `session-row.tsx`.
- Name the concept or responsibility precisely: `SessionRow`, `TurnStatus`, `loadSession`. Use the same term for the same concept across its callers, implementation, and tests.
- Use noun phrases for values and types, verb phrases for functions, and predicates such as `isVisible`, `hasChanges`, and `canEdit` for booleans.
- Events describe what happened (`turnFinished`); commands describe what to do (`startTurn`).
- Spell identifier suffixes consistently: `sessionId`, `projectId`, `imageUrl`. Prefer full words, with established abbreviations such as `id`, `url`, and `api` used consistently.
- Preserve names required by external or persisted contracts at their boundary. Map them to application conventions in `src/server/wire/`; do not rename serialized fields to satisfy a local naming preference.
- DOM hooks use descriptive `kebab-case` values. Each `data-component` value, and each `data-slot` value outside `src/ui`, must have a reader in styles, code, or tests. Every selector must match a value the app or UI kit writes. Dynamic hook values must have a finite string-literal union type.

## State and state machines

- **Any state with more than two values is an explicit machine:**
  - a discriminated union of states (`{ kind: "loading" } | { kind: "ready"; data } | { kind: "failed"; error }`);
  - a union of events;
  - one pure `transition(state, event)` with an exhaustive switch, built with `machine()` from `src/lib/machine.ts`.
  - Effects run outside the transition. No parallel booleans (`isLoading`, `isError`, `hasData`) describing one thing.
- **Make illegal states unrepresentable.** A field that exists in only one state lives only in that state's variant.
- **Server-owned lifecycles** (session, turn, request, cloud workspace, remote access) are fed only by the adapter's mapping of server data and events. Views never guess status from timing or message contents.
- **Every datum has one home:**
  - **Data the server pushes** (sessions, status, transcript, requests, todos) lives in one Solid store per domain, fed by the snapshot and the stream through the adapter. Deltas are coalesced per frame and applied in place.
  - **Data the app fetches** (projects, machines, accounts, tasks, files, git, Marketplace, usage) lives in the TanStack Query cache, through the query options in `src/server/<area>.ts`. Events only invalidate it, through the adapter's event table. `setQueryData` is only for a mutation's own result, inside `src/server/`.
  - **Not allowed:**
    - a second copy of any datum;
    - Promises, counters or UI state in the query cache;
    - module-level mutable state;
    - an effect that copies one store into another (derive with memos instead).
- **UI state that belongs to one component stays in that component.** Persisted UI preferences go through `persisted()`, keyed by user and `SessionLocation`.

## Errors

- **Errors are typed values.** Every failure has:
  - a class (`auth`, `rate_limit`, `network`, `not_found`, `conflict`, `invalid`, `internal`) from `src/server/errors.ts`, the one place that reads server responses;
  - a `retryable` flag;
  - a cause.
  - Never match on message text anywhere else.
- **A failure becomes a machine state and is shown, or logged with context.** Not allowed:
  - `.catch(() => default)`;
  - an empty `catch`;
  - a silent fallback;
  - a retry loop, apart from the stream's bounded, visible reconnect.
- **User-facing error copy comes from one table**, class → message, in i18n.
- **Every pane and every plugin slot has an error boundary.**

## Loading states

- Every async view renders from its machine: idle, loading, ready or failed, each drawn explicitly. No spinner without a failure path.
- Show a placeholder only after `PLACEHOLDER_DELAY_MS` (50 ms, `src/lib/delay.ts`), so fast loads don't flash; past `SLOW_LOAD_MS` (2 s) it says what the load waits for. A secondary load never blocks the shell or the transcript.
- Optimistic changes are pending entries in the store, confirmed or rolled back by the server; never a second copy of the data.

## Performance

- Benchmarks are not a completion gate. Run them only when the user requests benchmarking or performance measurement, following the root validation policy.
- **No polling.** Timers only for bounded backoff and debouncing, each owned by one named module.
- **No main-thread task over 50 ms during an interaction.**
- **Every cache has a size cap, and every subscription is disposed with its owner.**

## Benchmark driver

- The agent-app-benchmark's Claxedo driver lives on the `agent-app-benchmark` branch, at `packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts`, not on `dev`. Point `CLAXEDO_BENCHMARK_DRIVER` at that file in a checkout of the branch when benchmarking another build.
- Its readiness predicates read the app's hooks. The `data-slot` and `data-component` selectors it needs are listed in `scripts/checks/data/benchmark-driver-selectors.txt`: `claxedo-names` counts them as read and fails when nothing writes one. No check sees its `data-testid` selectors. Change the driver on that branch and the list together.

## End-to-end tests

The suite must be robust, working, honest and fast.

- **Real stack only.** The real app against the real daemon, runtime, relay and Worker. Fakes only at external boundaries:
  - the scripted model endpoint;
  - a scripted ACP agent;
  - a local sandbox driver;
  - a scripted OAuth provider.
  - No test-only paths in production code.
- **One spec per user flow**, named `NN-flow-name.spec.ts`.
  - Arrange through the API, act through the UI.
  - Assert what the user sees and one fact read back from the server.
  - Select by role and accessible name, then by the frozen hook list.
  - No CSS-class selectors and no sleeps; wait on a visible state.
- **Every spec is proven able to fail:** record its red run (a scripted failure, or the feature switched off). When asserting an absence or a filter, check every route that answers the same question.
- **Before a spec merges,** it passes final verification. Do not require fixed repetition counts locally or in CI. Repeat tests only to investigate a specific failure or flake, and find the cause before retrying.
- **Fast:** one flow in 60 seconds or less locally on a warm harness; the full suite in 12 minutes or less on CI.
- **A change to user-visible behavior adds or updates its flow in the same change**, at desktop width and in the `phone` project.

## One owner per concept

- Right side panels use the shared components and full-height shell mounting in [`src/ui/AGENTS.md`](src/ui/AGENTS.md); caller-specific state and policy stay in domain wrappers.
- Before writing code, read the domain's `README.md`, nearby implementations, callers, and tests to understand its patterns and find the concept's owner. Extend or improve that owner. Extract shared behavior when it removes duplication or gives a responsibility a clear home, then remove the paths it replaces. Keep abstractions driven by the current work rather than hypothetical reuse.
- A domain `README.md` lists the concepts it owns, its state machines and its flows. Adding a concept adds it there.
- Before starting a task, check the plan's progress notes and open branches for the same work. Claim the task in the plan, and edit only the files your lane owns.

## Checks

`bun run check` in this package (`scripts/checks/run.ts`) typechecks the checks, then runs:
- no comments;
- size;
- v2 only;
- Claxedo names;
- adapter boundary;
- no swallowed errors;
- no polling;
- one home per datum;
- domain boundaries;
- one owner;
- one registration;
- no directory identity;
- access boundary;
- protected areas, which names the corpus flows a working-tree change must run and never fails;
- e2e hygiene;
- budget;
- freshness;
- CSS invalidation.

During implementation, run only checks and tests targeted to the current change. Once all requested implementation work is finished, run `bun run check`, `bun run typecheck`, `bun run test`, and the applicable broader flows once as final verification. All checks must be at zero. If a check fails, investigate and rerun only the affected checks after fixing the cause; repeat broader validation only when evidence warrants it. CI runs the checks in the `app rule checks` job of `.github/workflows/test.yml`, and the root `prepush` runs them too.
