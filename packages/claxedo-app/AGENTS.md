# Claxedo app

This package is the Claxedo app. These rules apply to everything in it. The repo root `AGENTS.md` still applies; where the two differ, this file wins for this work.

## Today's server

The app runs on today's server contracts. `src/server/` is the only place that knows routes, payloads and event names, and `src/server/wire/` is the only place that uses the server's names. Everything else uses Claxedo types from `src/server/index.ts`. Do not change a server contract from this package's work.

## Areas that need extra care

- **Transcript** (`src/transcript/`, `src/session/view/timeline/`):
  - Hundreds of fixes live here. Change its logic only in a slice of its own, proven by the corpus (flow 30) and signed off by the owner.
  - Mechanical changes (imports, names by the codemod, a kit twin that renders the same) still run the whole corpus.
  - A fix here adds a corpus case in the same change.
- **Session list** (`src/session/list/`):
  - One store owns rows, order and reconciliation. Nothing else fetches, caches or patches rows.
  - The reconcile rules are the first section of its `README.md`. A change to them changes the README and the race flows (flow 31) in the same change.
- **Projects:**
  - A project is a server record with an id. A folder, a worktree or a cloud workspace is a placement.
  - Never use a folder path as a key, a route parameter or a stored identity. Only `src/server/` turns a placement into a directory.
  - Design flows for hosted first.
- **Phone:**
  - Every screen and plugin slot has a phone layout at 390 px: the sidebar as a drawer, panes as sheets, no hover-only controls, touch targets of at least 44 px, no horizontal scroll.
  - A new screen extends flow 33 in the same change.

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
- A file stays under 300 lines, a function under 40 and a component under 120. Past that, split along responsibilities; never compress lines to fit. The moved transcript files are split only in their own corpus-proven slice.
- Organize by domain, not by layer. A domain lives in `src/<domain>/` and has:
  - `model.ts`: types, events and state machines;
  - `store.ts`: state and actions;
  - `api.ts`: calls into `src/server/`;
  - `view/`: components;
  - `index.ts`: the domain's public surface;
  - `README.md`: owned concepts, machines, flows.
  - Folders go at most three levels deep.
- Import another domain only through its `index.ts`. Shared code lives in `src/lib/<concept>.ts` only when two or more domains use it; otherwise it lives with its one user.

## Names

- Use Claxedo names only, outside `src/server/wire/`:
  - `sessionId`, not `sessionID` (same for message, part, provider, model, call and project ids). The runtime contract's own fields `sessionID`, `messageID`, `partID`, `providerID` and `modelID` keep their spelling as property keys and accesses; a local, a parameter, a prop or an app type that names one uses the Claxedo spelling;
  - a `data-component` value, and a `data-slot` value outside the kit (`src/ui`), exists only where something reads it: a stylesheet (the kit's or the app's), a selector in code or an e2e flow; and a selector string in code selects only a value something writes (a JSX attribute, `dataset.x =` or `setAttribute`, in the app or the kit). `scripts/checks/claxedo-names.ts` fails an unread value, a computed value whose type is not a union of string literals, and a dead selector;
  - `@claxedo/*`, never `@opencode-ai/*` outside `src/ui`: today's kit (`@opencode-ai/ui`, `@opencode-ai/session-ui`) is the look, and code reaches it only through `@/ui`;
  - no `oc-` prefixes, no `globalSDK` or `globalSync`, no OpenCode event names, no `directory` routing.
- Name the domain concept, not the mechanism: `SessionRow`, `TurnStatus`, `startTurn`.
- Events are past tense (`turnFinished`); commands are imperative (`startTurn`).
- No abbreviations except `id`, `url` and `api`.

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
- Show a placeholder only after 150 ms, so fast loads don't flash. A secondary load never blocks the shell or the transcript.
- Optimistic changes are pending entries in the store, confirmed or rolled back by the server; never a second copy of the data.

## Performance

- **Budgets are part of done:**
  - session switch p95 ≤ 50 ms cold and ≤ 20 ms warm;
  - app start ≤ 1.1 s;
  - idle CPU ≤ 4%;
  - idle memory ≤ 700 MiB;
  - an 8 MiB long-row session ready in ≤ 2.4 s.
  - The agent-app-benchmark verdict must lose no row against the build before the change.
- **No polling.** Timers only for bounded backoff and debouncing, each owned by one named module.
- **Lists longer than 100 rows are virtualized.**
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
- **Before a spec merges,** it passes 20 runs in a row locally and 3 repeated runs in CI. A flaky spec is a bug: find the cause before retrying.
- **Fast:** one flow in 60 seconds or less locally on a warm harness; the full suite in 12 minutes or less on CI.
- **A change to user-visible behavior adds or updates its flow in the same change**, at desktop width and in the `phone` project.

## One owner per concept

- Right side panels use the shared components and full-height shell mounting in [`src/ui/AGENTS.md`](src/ui/AGENTS.md); caller-specific state and policy stay in domain wrappers.
- Before writing code, find the concept's owner (the domain `README.md` owner lists first, then the code) and extend it. Two implementations of one concept are a defect even when both work.
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

All must be at zero before a change is done, with `bun run typecheck` and `bun run test` passing. CI runs the checks in the `app rule checks` job of `.github/workflows/test.yml`, and the root `prepush` runs them too.
