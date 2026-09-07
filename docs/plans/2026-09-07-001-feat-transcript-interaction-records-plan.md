# Permissions, questions, and todos as transcript records

Status: proposed, not started
Last updated: 2026-09-07
Scope: local runtime (`workspace-runtime`), presentation projection (`agent-event-runtime`), session UI (`session-ui`, `claxedo-app`)

## Direct answer: why they are transient today

Permission, question, and todo state is transient in the UI because it is transient in the data model, and the UI faithfully renders the model. The transcript is exactly `message` rows plus `part` rows. Permissions and questions are never parts. They live in `pending_permission` / `pending_question` tables that are **deleted on reply** (`packages/workspace-runtime/src/store.ts:2144`, `:2165`), and the client mirrors that with a per-session `requests` cache that does `removeById` on `permission.replied` / `question.replied` (`packages/claxedo-app/src/features/session/data/sync/directory-event-projector.ts:154-176`). Todos are a single "current list" table per session (`todo`, replaced wholesale on every `todo.updated`), so there is no record of when a list appeared or how it evolved.

This is inherited from upstream OpenCode's v1 app: pending requests are lifecycle objects (asked → replied) exposed via `GET /permission` and `GET /question`, and the app renders whatever is pending in a dock over the composer. Nothing in the pipeline was ever wrong; the record was simply never a first-class transcript object.

The journal already keeps the history. Every `permission.asked`, `permission.replied`, `question.asked`, `question.replied`, `question.rejected`, and `todo.updated` event is committed to `runtime_journal` and never pruned (only `message.part.updated` snapshots for the same part are deduplicated, `store.ts:1528`). So this feature is a projection change, not a capture change.

## Current flow (observed code)

Three flows share the same skeleton. Permission is traced fully; question and todo differ only where noted.

**A. Harness emits the request.**
- A.1 `agent-event-runtime/src/harnesses/claude/adapter.ts:566` (`permissionFromToolUse`) emits `AgentRuntimeEvent { type: "permission-request", requestId, tool, paths }` on `claude/can-use-tool`. Codex does the same at `codex/adapter.ts:816`, ACP at `agent-sdk-runtime/src/harnesses/acp/process.ts:261`. OpenCode passes its own `permission.asked` through (`opencode-server-adapter/src/translate.ts:17`) and, alone among harnesses, carries `tool: { messageID, callID }`.
- A.2 Questions: Claude `questionFromToolUse` (`claude/adapter.ts:546`) emits `{ type: "question", requestId, questions }` for `AskUserQuestion`; Codex at `:826`. OpenCode also has a native `question` **tool part**, which is why `message-part.tsx:3041` has a `question` tool renderer and the timeline hides it while pending (`message-timeline.data.ts:629`).
- A.3 Todos: Claude (`claude/adapter.ts:211`), Codex (`:783`), Cursor (`:527`), ACP (`translate-session-update.ts:554`) emit `{ type: "todo-update", todos }`. OpenCode translates `todo.updated` to the same (`translate.ts:101`). OpenCode and Claude additionally produce a `todowrite` tool part, which the timeline hides (`hiddenTools`, `message-timeline.data.ts:467`; renderer at `message-part.tsx:2990` is dead-on-arrival because `:1839` returns null first).

**B. Projection turns runtime events into presentation events.**
- B.1 `agent-event-runtime/src/projections/client-presentation/projection.ts:1341` maps `permission-request` → `permission.asked` with `metadata: {}` and **no `tool` link** (the `callID` is dropped, so nothing ties the request to the tool part it gates). `question` → `question.asked` (`:1351`), `question-answered` → `question.replied` (`:1358`), `todo-update` → `todo.updated` (`:1361`).

**C. Server journals and projects.**
- C.1 The turn loop appends each presentation event via `store.appendEvent` (`store.ts:2504`) and publishes the returned payload over SSE (`routes/session-core.ts` turn stream, `publishGlobal`).
- C.2 `store.project()` upserts `pending_permission` on `permission.asked` (`:2125`), deletes it on `permission.replied` (`:2144`), marks it `stale` on the `permission.staled` control (`:2018`, emitted by `stalePermission` `:2838` when the turn ends without a reply). **No client event is emitted for stale**; the client only learns via a later `GET /permission` refetch or the abort path in `submit-abort.ts:84` clearing the cache locally.
- C.3 `todo.updated` replaces the `todo` table (`:2114`).

**D. User decides.**
- D.1 `SessionPermissionDock` (`claxedo-app/.../composer/session-permission-dock.tsx`) is mounted by `session-composer-region.tsx:237` when `session-composer-state.ts:89` finds a visible pending request in the session tree's `requests` query. Buttons call `decide` → `POST /session/:sessionId/permissions/:permId` with `{ response: "once" | "always" | "reject" }` (`session-core.ts:1846`). The route calls `adapter.respondPermission` and publishes `permission.replied { reply }` (`:1879`). **The event does not say who decided**; auto-accept in `providers/permission.tsx:respondOnce` hits the same route and is indistinguishable.
- D.2 Questions: `SessionQuestionDock` posts `POST /question/:id/reply { answers: string[][] }` or `/reject`; the route publishes `question.replied { answers }` / `question.rejected`.
- D.3 Todos: `SessionTodoDock` reads the `todo` cache query and shows while the session is live and the list is incomplete; it auto-closes when done (`session-composer-state.ts:105-115`).

**E. Client applies and renders.**
- E.1 `event-router.ts:targetedQueryKeys` sends the five request events to `shellDataKeys.sessionId(id, "requests")` and `todo.updated` to `(id, "todo")`. The projector upserts/removes (`directory-event-projector.ts:139-176`). These caches are `skipToken` (cache-only, `queries.ts:365-374`); hydration on session open comes from `GET /permission` + `GET /question` in `session-controller.ts:285-289`, and rail badges do the same directory-wide (`rail-sidebar.tsx:898`).
- E.2 The transcript (`message-timeline.data.ts:constructMessageRows`) is built only from parts. Rows are `part | context | work | agents`. No request or todo row kind exists. The dock is the only place these ever appear, and it unmounts on reply.

**Result:** after a reply the interaction vanishes from the screen and from every client-readable store. Reload shows nothing. The channels product already does the opposite for chat surfaces: `claxedo-channels/src/core/reply-sink.ts:57` maps `permission.asked` to an `ApprovalRequest` message that stays in the chat thread. That is the Grok-bot behavior the screenshots show.

## Target behavior

Modelled on the two screenshots:

- **Permission card in the transcript** at the point in the assistant turn where it was asked: title ("wants to run `bash`"), status pill (`Pending` → `Allowed once` / `Allowed always` / `Denied` / `Auto-allowed` / `Expired`), a collapsible "details" region with the patterns and, when linked, the gated tool call. Pending cards also drive the composer dock exactly as today. The card stays after the decision.
- **Question card in the transcript**: the question text and options, the chosen answer(s) checked after reply, `Dismissed` on reject, `Expired` if the turn ended first. Pending cards drive the wizard dock.
- **Task lists split into two surfaces with one record.** Permissions and questions are pure history and flow upward. A task list is different: the *current* list is working context the user wants in front of them, and only its past revisions are history. So:
  - The **composer tray** (the "context card") shows the newest list while the session is live and the list is incomplete, exactly today's rule. It is a view over the newest `todo` part, not a separate cache.
  - The **transcript** holds one card per list *identity*, placed where the list was first written, mutated in place as revisions arrive (the Cursor screenshot's `0 of 8` counter). Every `todo.updated` is a revision, never a new card, unless it starts a new list (rule below).
  - **While a list is pinned in the tray**, its transcript card renders as a compact anchor row (`Tasks · 3 of 8 · shown below`) so the full list is never on screen twice. When the tray closes (list done, or superseded), the anchor expands into the full final card at that spot.
  - **Older lists freeze.** When a new list starts, the previous card stops receiving revisions and keeps its final state, unfinished items included, collapsed by default with a summary line (`Tasks · 5 of 8 · superseded`). Nothing rewrites history to match the newer list.
  - Before any list exists, neither surface shows anything, as today.
- Reload, cold hydration, remote/relay viewers, and shared sessions all see the same records, because they are parts.

## Design: interaction records are parts

One rule: **the store's journal projection materializes interaction records as parts on the active assistant message, and everything downstream treats them as parts.** No new client cache, no new route, no new event type on the wire.

### New part kinds (`agent-runtime-contract/src/content.ts`)

```ts
export type AgentPermissionPart = AgentPartBase<"permission"> & {
  requestID: string
  permission: string           // tool classification, as today
  title?: string
  patterns: string[]
  always: string[]
  tool?: { messageID: string; callID: string }
  state:
    | { status: "pending"; time: { asked: number } }
    | { status: "decided"; reply: "once" | "always" | "reject"; decidedBy: "user" | "auto"; time: { asked: number; decided: number } }
    | { status: "expired"; time: { asked: number; expired: number } }
}

export type AgentQuestionPart = AgentPartBase<"question"> & {
  requestID: string
  questions: AgentQuestionInfo[]
  tool?: { messageID: string; callID: string }
  state:
    | { status: "pending"; time: { asked: number } }
    | { status: "answered"; answers: AgentQuestionAnswer[]; time: { asked: number; answered: number } }
    | { status: "rejected"; time: { asked: number; rejected: number } }
    | { status: "expired"; time: { asked: number; expired: number } }
}

export type AgentTodoPart = AgentPartBase<"todo"> & {
  todos: AgentTodo[]
  revision: number             // increments per todo.updated applied to this list
  time: { created: number; updated: number }
}
```

`done` (every item completed or cancelled) and `superseded` (a newer `todo` part exists in the session) are derived by the reader, not stored, so the part cannot disagree with itself. The part id is `todo:<assistantMessageID of the first write>`.

```ts
```

Illegal states are unrepresentable: a decided permission always has a reply and an actor; an answered question always has answers. Part ids are deterministic (`permission:<requestID>`, `question:<requestID>`, `todo:<assistantMessageID>`), so replays and duplicate deliveries upsert instead of duplicating.

### Where they are produced (change point C.2)

`store.project()` gains three derivations, each returning the `message.part.updated` events it appended so the existing caller publishes them exactly as it publishes the turn-completion events it already derives (`store.ts:2571-2611` is the precedent):

- `permission.asked` → upsert `pending_permission` (unchanged, it is the cheap directory-wide index the rail and auto-accept reconciliation use) **and** upsert an `AgentPermissionPart` with `status: "pending"` on the active turn's `assistant_message_id`.
- `permission.replied` → delete from the index (unchanged) **and** set the part to `decided`.
- `permission.staled` control → mark index stale (unchanged) **and** set the part to `expired`. This closes the C.2 gap where stale never reaches clients.
- Same three for questions.
- `todo.updated` → replace the `todo` table (unchanged, plus a `part_id` column naming the list it belongs to) **and** apply the list-identity rule:
  - **Revision** of the newest list when the write comes from the same assistant message as that list, or when at least one incoming item's `content` matches an item in the newest list. Upsert the existing part with the new items and `revision + 1`.
  - **New list** otherwise: create `todo:<current assistantMessageID>` at `revision: 1`. The previous part is left untouched; the reader derives `superseded` from the existence of a newer part.
  - **Empty write** (`todos: []`): the newest list keeps its items and stops receiving revisions; no new part is created. The journal still records the clear.
  The rule is deterministic over journal contents, so replay reproduces the same cards.

Attachment rule: the active `turn.start` control's `assistant_message_id` (already read the same way at `store.ts:2550`). Requests only arrive from a running turn, so an active message always exists; if the journal is ever replayed for a session whose turn row is missing, the projection attaches to the most recent assistant message and records a `runtime.diagnostic` rather than dropping the record.

Replies that originate from HTTP routes (`session-core.ts:1846`, `/question/:id/reply`, `/reject`) already go through `appendEvent` + `publishInteractionEvents`; they pick up the derived part event from the same return value. The permission route additionally reads a new `source: "user" | "auto"` field from the body and stamps it into `permission.replied` as `decidedBy`. The client's `respondOnce` (auto path) sends `source: "auto"`; the dock's `decide` sends `"user"`. The e2e contract file `claxedo-app/e2e/helpers/contracts/session-interactions.ts` pins the body shape and must be updated in the same slice.

### What is deleted

- Client per-session `requests` cache: `shellDataKeys.sessionId(id, "requests")`, the `session.requests` synthetic event and its dispatchers (`directory-event-projector.ts:51-61`, `session-status-dispatcher.ts:51`, `submit-abort.ts:84-104`, `directory-session-meta.ts:63`, `session-question-dock.tsx:219`), and `permission.list` / `question.list` hydration in `session-controller.ts:285-289`. The docks read pending parts from the conversation store instead. `GET /permission` and `GET /question` stay for the rail's directory-wide badge and for `providers/permission.tsx` auto-accept reconciliation; they are views over the same journal, not a second store.
- Client `todo` cache (`shellDataKeys.sessionId(id, "todo")`, `session.todo` event). The tray reads the newest `todo` part.
- The `question` tool renderer (`message-part.tsx:3041`) and its pending-hide branches (`message-part.tsx:1841`, `message-timeline.data.ts:629`); the `question` tool part joins `hiddenTools` alongside `todowrite`. The `todowrite` renderer at `message-part.tsx:2990` is deleted (it is unreachable today).
- `projection.ts` gains `tool: { messageID, callID }` on `permission.asked` / `question.asked` whenever the harness event carries a `toolCallId` (add the optional field to `permission-request` and `question` in `agent-runtime-contract/src/events.ts`; Claude and Codex have the id at hand). This is what lets the card's "details" show the gated call.

### Rendering

- `session-ui/src/components/interaction-part.tsx` (new, with stories): `PermissionCard`, `QuestionCard`, `TodoCard`, all flat hairline cards in the existing tool-card idiom (`BasicTool` trigger + collapsible body). Status pill vocabulary is a literal i18n key table, not a template key (see the `settings.permissions.tool.*.description` trap already present in `session-permission-dock.tsx:16`).
- `message-timeline.data.ts`: add `permission`, `question`, `todo` to `renderableParts`; they are standalone `part` rows, never folded into `work` groups.
- `message-part.tsx`: dispatch the three new part types to the cards.
- Docks: `session-composer-state.ts:85-99` derive `questionRequest` / `permissionRequest` from pending parts across the session tree (same tree walk, same `include` policy filter); `todos` from the newest todo part. `SessionPermissionDock`, `SessionQuestionDock`, `SessionTodoDock` are unchanged as input surfaces; only their data source moves.
- Todo tray / transcript handoff: one boolean, `pinned = live && !done` for the newest todo part (the existing `dock` condition in `session-composer-state.ts:115`). `TodoCard` receives `pinned` and renders the compact anchor when true, the full list when false. Older parts always get `pinned = false` and `superseded = true`, so they render collapsed with the summary line. No card is ever hidden; the anchor guarantees a scroll target for "where did this list start".

### Second store

`agent-sdk-runtime/src/stores/{memory,sqlite}.ts` project the same events for the SDK runtime. Because the transcript record is delivered as `message.part.updated`, those stores persist it through their existing part path with **no** interaction-specific code. The interaction-specific derivations live only in `workspace-runtime/src/store.ts`; `agent-sdk-runtime` stores keep their pending tables as-is for their own index. Verify this with a test that feeds the derived events into the sqlite store and reads the parts back.

## Phases and Definition of Done

### Phase 1 — contract and projection (server only)

- [ ] `AgentPermissionPart`, `AgentQuestionPart`, `AgentTodoPart` added to `AgentContentPart`; `permission-request` / `question` runtime events accept optional `toolCallId`; `permission.replied` carries `decidedBy`. Progress:
- [ ] `store.project()` materializes the three part kinds as specified, returns derived `message.part.updated` events, and the turn loop and interaction routes publish them. Progress:
- [ ] `permission.staled` / `question.staled` set `expired` on the part and the client receives it. Progress:
- [ ] Journal replay of an existing session produces identical parts to live ingestion (test: ingest live, snapshot parts; wipe projection tables, replay, compare). Progress:
- [ ] `GET /session/:id/message` hydrates the new parts in order on cold load. Progress:
- [ ] `agent-sdk-runtime` sqlite store round-trips the derived part events unchanged. Progress:
- [ ] `bun run test:architecture-ratchets` green; no new production import edges beyond the contract package. Progress:

### Phase 2 — client reads parts, caches deleted

- [ ] `requests` and `todo` client caches, `session.requests` / `session.todo` synthetic events, and `permission.list` / `question.list` session hydration removed; repository search shows zero remaining readers. Progress:
- [ ] Docks derive pending state from parts; `core-docks.spec.ts` (permission, question wizard, todo tray) passes against the mock runtime updated to emit part events. Progress:
- [ ] `permission_decided` telemetry unchanged in shape; `decidedBy` in the wire body pinned by `session-interactions.ts`. Progress:

### Phase 3 — transcript rendering

- [ ] Cards rendered for all three kinds with stories covering every `state.status`. Progress:
- [ ] Question tool renderer and `todowrite` renderer deleted; both tools in `hiddenTools`. Progress:
- [ ] Reload after a decided permission, an answered question, a rejected question, an expired request, and a completed todo list shows the record in place (e2e per case, on the signed local web app). Progress:
- [ ] Todo handoff: while live and incomplete, the tray shows the full list and the transcript shows only the anchor row; when the last item completes, the tray closes and the anchor expands in place; a new list in a later message freezes the old card as superseded with its unfinished items still visible (one e2e covering the three transitions, plus a store test that eight revisions produce one part at `revision: 8`). Progress:
- [ ] Harness matrix (`core-harness-rendering-matrix.spec.ts`) extended: OpenCode, Claude, Codex, Cursor, ACP fixtures each produce the cards. Progress:

### Overall DoD

- [ ] One producer (store projection), one delivery path (`message.part.updated`), one hydration route, one renderer per record kind.
- [ ] No transient request or todo state survives on the client outside the conversation store.
- [ ] Remote/relay viewer of a shared session sees identical cards (relay e2e).
- [ ] Typecheck via each package's own `scripts.typecheck`, root `bun turbo typecheck`, oxlint bare root run, ratchets, and the listed e2e suites all green; commands and outcomes recorded in the PR description.

## Verification loop per slice

Red test first in the owning package (`store.test.ts` for projection, `directory-event-projector.test.ts` deletions, session-ui stories + `core-docks.spec.ts`). Prove the positive flow and the negative flows: reject, expired, duplicate delivery (same request id twice), reply for an unknown id (route returns 404, no part written), reload mid-pending.

## Execution: parallelize with agents and workflows

Disjoint ownership, run as one workflow after Phase 1's contract lands:

1. Contract + projection (`agent-runtime-contract`, `agent-event-runtime/projection.ts`, `workspace-runtime/store.ts`, routes) — one agent, sequential, unblocks the rest.
2. Client data path deletions (`claxedo-app/src/features/session/{data,store,providers,composer}`) — one agent.
3. Cards + stories (`session-ui`) — one agent, can start from the contract alone.
4. Timeline and message-part wiring (`claxedo-app/.../ui/message-timeline*.ts`, `session-ui/message-part.tsx`) — one agent, depends on 3.
5. e2e mock runtime and contracts (`claxedo-app/e2e/helpers/*`, `core-docks.spec.ts`, harness matrix fixtures) — one agent in parallel with 2 to 4.
6. Verification agent runs the full gate list and reports exact commands and outcomes.

Agents must not `git checkout --` or stash on the shared worktree; each owns its file set and the integrator merges.

## Downsides and open questions

- **Transcript density.** A permission-heavy turn (Claude in default mode asks per tool) produces many cards. Mitigation in Phase 3: consecutive decided permission parts with the same reply fold into a single chip row ("3 allowed"), the same way consecutive `task` parts fold into `agents`. Pending cards never fold.
- **Auto-allowed noise.** With directory auto-accept on, every tool produces an auto-allowed card. The fold above covers it; a per-viewer "hide auto-allowed" toggle can come later as a view preference, not a data change.
- **List identity is a heuristic.** "Shares one item's content with the newest list" is the only cross-message signal available, because every harness sends the whole list on each write with no list id. An agent that rewrites every item's wording in one step will start a new card. The journal keeps every revision, so a wrong split can be corrected later by a replay with a better rule; no data is lost. Rejected alternatives: one card per revision (a Claude turn writes a dozen revisions, so the transcript would be mostly todo cards), and one card per session (a later, unrelated task list would overwrite the record of the first one).
- **Ordering inside a message.** Parts order by `ord`; the derived part takes the next ordinal at ask time, so it lands after the tool part that triggered it for harnesses that emit the tool part first (OpenCode) and before it for harnesses that emit the permission before the tool start (Claude). Acceptable, but the card's `tool` link exists so the renderer can co-locate visually if that proves confusing.
- **Existing sessions.** Sessions journaled before this change gain records on the next replay (projection tables are rebuilt from the journal), so history back-fills without a migration. Sessions whose journal was pruned by `session.delete` are gone anyway.
- **Not in scope.** The channels `ApprovalRequest` path stays as is; it already records in-thread. Goal and revert docks are unrelated and untouched.
