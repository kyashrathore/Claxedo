# Session titles: harness-native where it exists, runtime-generated elsewhere

Status: implemented on `feat/session-auto-title` (2026-09-16), all lanes;
live-verified for Claude; Codex and Pi live proofs blocked by account quota
and auth on the dev machine (recorded per row below).

Assessed 2026-09-15 on local `dev` `156e7e0ab8` against the installed
harnesses: Claude Code 2.1.270 (`@anthropic-ai/claude-agent-sdk` 0.3.220),
Codex 0.154.0 (`codex app-server generate-ts`), Pi 0.85.1 (`docs/rpc.md`,
`docs/session-format.md`), `@cursor/sdk` 1.0.24, `@agentclientprotocol/sdk`
1.3.0, and the OpenCode adapter.

## The defect

A session's title is the first 72 characters of the first prompt, forever.

Flow today, starting from the first send:

- A. `AgentRuntime.sendMessage` (`agent-sdk-runtime/src/runtime.ts`) iterates
  `adapter.executeTurn`.
  - A.1 Harnesses on `SdkRuntimeAdapter` (Claude, Codex, Pi, Cursor;
    `harnesses/shared/sdk-runtime-adapter.ts:684`) yield
    `commitSdkAutomaticTitle` (`shared/sdk-runtime-title.ts`) right before the
    first `session.idle`: `deriveSessionTitle(extractTextFromParts(parts))`,
    appended to the store as `session.updated` with
    `source.method = "auto-title"`.
  - A.2 The ACP harness (`harnesses/acp/turn-runner.ts:629`) does the same
    through `maybeAutoTitle` (`harnesses/acp/title.ts`), with its own copy of
    `deriveSessionTitle` (different ellipsis character).
  - A.3 `runtime.ts:379 maybeEmitTitle` does it a third time for adapters
    that do not commit their own stream (OpenCode), on `session.idle` and
    again after the loop.
- B. Every one of these is gated on `hasConcreteSessionTitle(session.title)`
  (`src/session-title.ts`), which only rejects `New session`, `Session`, and
  the timestamped placeholders. The prompt-derived string passes, so from the
  second turn on nothing can replace it.
- C. `acp/title.ts generateAITitle` — the only model-generated title in the
  repository — has no callers (`grep -rn generateAITitle packages/*/src`
  returns its definition only).
- D. There is no title provenance. A user rename
  (`workspace-runtime/src/routes/session-core.ts:502` →
  `runtime.ts:616 update` → `store.updateSession`) is indistinguishable from
  the prompt-derived title, which is why `generateAITitle` had to compare the
  live title against a recomputed `deriveSessionTitle(userText)` to guess
  whether the user had renamed.

The store already applies any `session.updated` carrying a `title`
(`stores/memory.ts:708 applySessionUpdated`), and the projection already
turns two runtime events into that compat event
(`agent-event-runtime/src/projections/client-presentation/projection.ts:1527`
`session-info`, `:1542` `session-title`). The client reconciles those frames
into the rail without moving the row (`session-list.ts:497`; ordering is
`human_turn_desc`, a title write does not touch the ordering key). The
plumbing from "a title exists" to "the rail shows it" is done. What is
missing is producers, and a rule for who may overwrite whom.

## What each harness offers (verified)

| Harness | Generates a title itself | How the client learns it | How the client sets it |
| --- | --- | --- | --- |
| Claude Code (SDK) | **Yes.** `generateSessionTitle` runs concurrently with the first turn; result is cached as `aiTitle` and written to the transcript as `{"type":"ai-title","aiTitle":"…","sessionId":"…"}`. Once per session. | Not on the SDK message stream (no `system` subtype carries it — the internal `sessionTitleChanged` bus only feeds the terminal title). It **is** delivered through `options.sessionStore.append(key, entries)` as the `ai-title` entry, before the `result` message. Also `getSessionInfo(id,{dir}).summary` after the fact, and `session_title` on `UserPromptSubmit` / `SessionStart` hook inputs. Verified live 2026-09-15 with a `sessionStore` probe: `STORE ai-title entry: {"type":"ai-title","aiTitle":"Date parser leap year tests",…}` arrived twice, then `RESULT success`. | `rename_session` control request / `renameSession()` → `custom-title` entry; `options.title` at create skips generation. |
| OpenCode server | **Yes**, server-side model call. | `session.updated` SSE with `info.title`; `opencode-server-adapter/src/translate.ts:115` already maps it to `session-title`. | `PATCH /session/:id { title }` (`adapter.ts:73 updateSession`). |
| ACP agents (Gemini CLI, …) | Agent-dependent. Protocol has `session_info_update { title?, updatedAt? }` ("All fields are optional to support partial updates"). | `translate-session-update.ts:530` → `session-info`. **Defect:** `projection.ts:1532` writes `title: chunk.title ?? ""`, so an update carrying only `updatedAt` blanks the title. | None in the protocol. |
| Codex app-server 0.154 | **No.** The Codex **TUI** generates it (`tui/src/app/thread_title.rs`) with a "temporary structured turn" — prompt: *"Generate a concise, single-line task title of at most N characters and under five words where possible. Start with an imperative verb… Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request."* — then calls `thread/name/set`. The server only stores it: `Thread.name: string \| null` ("Optional user-facing thread title"), `Thread.preview` = first user message. | `thread/name/updated { threadId, threadName? }`. **Defect:** `agent-event-runtime/src/harnesses/codex/adapter.ts:837` reads `row.name ?? row.title`; the field is `threadName`. Notifications are only subscribed during a turn (`codex/driver.ts:335`). | `thread/name/set { threadId, name }` ("thread name must not be empty"). `thread/start { ephemeral: true }` + `turn/start { outputSchema }` are the primitives the TUI uses for the side turn. |
| Pi 0.85 (`--mode rpc`) | **No** built-in generation: `session_info` entries are "user-defined display name. Set via `/name`, `--name`/`-n`, or `pi.setSessionName()`". **But** the extension API has both halves: `ctx.modelRegistry.complete(model, { messages }, { cacheRetention: "none", … })` runs a completion with the session's configured auth (`examples/extensions/summarize.ts:181`), and `pi.setSessionName(name)` persists it (`examples/extensions/session-name.ts`). A Claxedo-shipped extension loaded with `-e <path>` ("explicit `-e` paths still work" under `--no-extensions`) can title in-process on the first `agent_end`. | `AgentSession.setSessionName` emits `session_info_changed { name }` on the session bus (`dist/core/agent-session.js:2453`), and RPC mode forwards every session event (`rpc-mode.js:265 session.subscribe → output(toJsonEvent(event))`), so the client receives `{"type":"session_info_changed","name":"…"}` unprompted. Also `get_state.sessionName`. | `{"type":"set_session_name","name":"…"}`; `--name` at spawn. The driver already runs one-shot `pi -p --mode json --no-session --no-tools --no-extensions …` for the Goal evaluator (`pi/driver.ts:114`), so that route is proven too. |
| Cursor SDK 1.0.24 (local) | **No.** `options.name`: "Cloud agents auto-generate a name from the first prompt when this is omitted; local agents fall back to a generic default." The backend does have `aiserver.v1.AiService.GetChatTitle { conversation[] } → { title }` — it is present as a generated client method in both `cursor-agent` 2026.09.10 and `@cursor/sdk` `dist/esm/index.js` — but neither bundle has a single call site, and it is not on the public SDK surface. Calling it would mean owning an undocumented internal RPC (ruled out: layer over harnesses). | `Agent.get().name` | `name` at create only. |

Conclusion: two harnesses hand us a title (Claude, OpenCode), one may (ACP),
one gives us the in-process primitives to make it native (Pi extension API),
and two give us only a side-turn primitive (Codex: ephemeral thread +
structured output, which is what its own TUI uses; Cursor: a plain local
run). None of the last three will ever produce a title on its own; the
Codex app-server has no title module at all (`tui/src/app/thread_title.rs`
is the only one in the binary), and Cursor's title RPC is server-side and
unexposed. The runtime therefore (1) accepts a native title wherever one
exists and (2) generates one through the harness where it does not.

## Goal

After the first completed turn, every session shows a short model-written
title in the rail and in the harness's own session listing where the harness
has one, without the user doing anything; a user rename is final; a session
whose harness produced no title still gets one; nothing in this plan changes
row ordering or the `AgentSession` wire shape beyond one optional field.

## Design

### Title provenance (the rule that makes overwrites safe)

`AgentSession` gains `titleSource?: "prompt" | "harness" | "user"`
(`agent-runtime-contract/src/sessions.ts`), persisted in the store's session
record (`runtime_sessions.data_json` is JSON; additive, no migration). Rank:
`user` > `harness` > `prompt` > unset. A write may land only when its rank is
≥ the current rank. Enforced in one place — the store — so no producer has
to guess:

- `store.updateSession(id, { title })` from the session route is `user`.
- A `session.updated` compat event carries `info.titleSource`; the store's
  `applySessionUpdated` drops the title part when the incoming rank is lower.
- `hasConcreteSessionTitle` is deleted; the rank replaces it. The `New
  session` / timestamped placeholders are simply "unset".

Child sessions (subagents, `parentID` set) never get generated titles; their
labels come from the spawn observation.

### One owner: `runtime.ts`

`AgentRuntime.sendMessage` already sees every adapter's `session.idle`
before the `commitsStreamEvents` branch (`runtime.ts:433`). It becomes the
only title producer:

- At turn start of a session with no title: commit + publish the
  prompt-derived title (`titleSource: "prompt"`) so the row has a name while
  the first turn runs, instead of after it.
- When the turn ends (`session.idle`, or the loop's end) and the session's
  `titleSource` is still `prompt`: call `adapter.generateTitle?` (below),
  fire-and-forget after the terminal events, commit the result as
  `session.updated { title, titleSource: "harness" }`, publish through
  `publishGlobal` (the precedent and the reason are already recorded in
  `workspace-runtime/src/bus.ts:90` and
  `claxedo-server/src/deployments/self-hosted-node/app.ts:1627`).
- If a `harness`-ranked title already landed during the turn (Claude,
  OpenCode, ACP `session_info_update`), generation is skipped.

`commitSdkAutomaticTitle`, `maybeAutoTitle`, the ACP copy of
`deriveSessionTitle`, and `generateAITitle` are deleted. One
`deriveSessionTitle` / `extractPromptTitleText` remains in
`src/session-title.ts`.

### Native titles in

- Claude: the write-only `sessionStore` observer in `claude/driver.ts:433`
  is currently attached only for Goal turns. Attach it on every turn
  (`load` still answers `null`, so the CLI keeps its own transcript and no
  import cost is paid — the comment there already establishes this). Entries
  with `type: "ai-title"` or `type: "custom-title"` are ingested as
  `claude/session-store` and the event adapter
  (`agent-event-runtime/src/harnesses/claude/adapter.ts`) maps them to
  `session-title`. `custom-title` maps with `titleSource: "user"` — a rename
  done inside Claude is the user's.
- Codex: `thread/name/updated` reads `threadName`.
- ACP: `session-info` projects a title only when the update carries one;
  `null` clears (spec: "Set to null to clear"), absent leaves it alone.
- OpenCode: unchanged; verified end to end in the DoD, including a title
  that arrives after `session.idle`.

The `session-title` runtime event gains `titleSource?: "harness" | "user"`
(default `harness`) so the projection can stamp the compat event.

### Generated titles out: `adapter.generateTitle?`

`AgentHarnessAdapter` (`adapter-contract.ts`) gains

```ts
generateTitle?(binding: AgentExecutionBinding, input: {
  directory: string
  transcript: string   // ≤ 1,500 chars: first user text + first assistant text
  model: PromptModel
  signal: AbortSignal  // 20 s budget
}): Promise<string | null>
```

`src/title-generation.ts` owns the prompt (one prompt for every harness,
modelled on Codex's: imperative verb, ≤ 60 characters, the user's language,
no quotes/markdown/trailing punctuation, "do not answer the request"), the
transcript excerpt, response cleanup (`<think>` stripping, first non-empty
line, length cap), and the "title must differ from the prompt-derived one
by more than whitespace/case" check. Drivers return raw model text only.

Per harness, on `SdkRuntimeDriver` as `generateTitle?`:

- Codex: `thread/start { cwd, ephemeral: true, model, developerInstructions:
  <title system prompt> }` → `turn/start { input: [text], outputSchema:
  { type: "object", properties: { title: { type: "string" } }, required:
  ["title"] } }` → collect `item/completed` agentMessage → `thread/archive`.
  Then `thread/name/set { threadId: <session thread>, name }` so
  `codex resume` shows the same name. This is the TUI's own recipe.
- ACP: the temp-session body of the deleted `generateAITitle` (boot a
  second ACP session, prompt, collect `agent_message_chunk`, cancel on
  timeout) moved into `acp/index.ts` as the adapter method.
- Pi: a Claxedo-owned extension file (`pi/title-extension.ts`, loaded with
  `-e` on the RPC spawn at `pi/driver.ts:245`) that, on the first
  `agent_end` of an unnamed session, calls
  `ctx.modelRegistry.complete(ctx.model, …)` with the shared title prompt
  and `pi.setSessionName(title)`. Pi persists the name in its own session
  file, its `/resume` picker shows it, and RPC mode pushes
  `session_info_changed { name }` to the driver, which ingests it as
  `session-title` (`harness`). This is preferred over a second `pi -p`
  process because it is one process, the session's own model and auth,
  and the harness's own persistence. The driver's `generateTitle` is then
  a no-op for Pi; the runtime only has to treat `session_info_changed` as
  the title source. Fallback if the extension API proves unavailable in
  RPC mode on this version: the one-shot `pi -p` route the Goal evaluator
  already uses.
- Cursor: one-shot through the driver's existing local executor with the
  session model; no write-back (the SDK has no rename).
- Claude, OpenCode: not implemented; they never reach it in practice, and
  when they do (OpenCode title generation failed) the prompt title stays.

Failure (timeout, no model, harness error) keeps the `prompt` title and
logs once at `warn` with the harness id; there is no retry.

### What is deleted, moved, kept

Deleted: `shared/sdk-runtime-title.ts`, `acp/title.ts` (`maybeAutoTitle`,
`generateAITitle`, its `deriveSessionTitle`, `firstPromptText`),
`hasConcreteSessionTitle`, the `titleEmitted` loops in
`sdk-runtime-adapter.ts` and `acp/turn-runner.ts`, and the
`inventory-writers.ts:216` comment that cites `maybeAutoTitle`.

Moved: title emission into `runtime.ts`; ACP title generation into the ACP
adapter.

Kept: `deriveSessionTitle` (as the `prompt`-ranked placeholder),
`session-title` / `session-info` runtime events, the store's
`applySessionUpdated`, the client's reconciliation, `bus.ts` global
publication.

## Change points

- `packages/agent-runtime-contract/src/sessions.ts` — `titleSource?` on
  `AgentSession`; `events.ts` — `titleSource?` on `session-title`.
- `packages/agent-event-runtime/src/contracts/agent-runtime-event.ts` —
  same field on the runtime event and its constructor.
- `packages/agent-event-runtime/src/projections/client-presentation/projection.ts`
  — `session-info` projects a title only when present; both cases stamp
  `titleSource`.
- `packages/agent-event-runtime/src/harnesses/codex/adapter.ts:837` —
  `threadName`.
- `packages/agent-event-runtime/src/harnesses/claude/adapter.ts` —
  `claude/session-store` payloads: `ai-title` → `session-title`
  (`harness`), `custom-title` → `session-title` (`user`).
- `packages/agent-sdk-runtime/src/stores/memory.ts` (+ `sqlite.ts` through
  the shared record) — rank rule in `applySessionUpdated`; `updateSession`
  from the route stamps `user`.
- `packages/agent-sdk-runtime/src/runtime.ts` — the single title owner:
  prompt title at turn start, `generateTitle` after the terminal events.
- `packages/agent-sdk-runtime/src/adapter-contract.ts`,
  `harnesses/shared/sdk-runtime-driver.ts`,
  `harnesses/shared/sdk-runtime-adapter.ts` — `generateTitle?` plumbing;
  `titleEmitted` loop removed.
- `packages/agent-sdk-runtime/src/title-generation.ts` — new: prompt,
  excerpt, cleanup, acceptance.
- `packages/agent-sdk-runtime/src/harnesses/claude/driver.ts` — the
  observer store on every turn; `ai-title`/`custom-title` ingest.
- `packages/agent-sdk-runtime/src/harnesses/codex/driver.ts` — ephemeral
  structured title turn; `thread/name/set` write-back.
- `packages/agent-sdk-runtime/src/harnesses/pi/driver.ts`,
  `pi/rpc-process.ts` — one-shot `pi -p` title run; `set_session_name`.
- `packages/agent-sdk-runtime/src/harnesses/cursor/driver.ts` — one-shot
  title run.
- `packages/agent-sdk-runtime/src/harnesses/acp/index.ts`,
  `acp/turn-runner.ts` — adapter `generateTitle`; `maybeAutoTitle` call
  removed.
- `packages/claxedo-app/src/features/session/data/sync/inventory-writers.ts`
  — comment rewritten from the new producer (runtime, not ACP).
- `docs/plans/README.md` — this entry.

Unchanged contracts: `session.updated` remains the only frame the client
consumes for titles; `human_turn_desc` ordering; `session.update` route
body; the `AgentSession` fields the client reads today.

## Definition of done

Each harness row is verified on the signed local web app
(`claxedo-server` + `claxedo-app dev:local`) with a fresh session and one
prompt long enough to title (≥ 20 words), by reading the rail *and* the
harness's own listing where it has one.

- [ ] Claude: the rail shows Claude's own AI title (matches the `ai-title`
      entry in `~/.claude/projects/<dir>/<session>.jsonl`) before or at the
      end of the first turn; the prompt-derived title is visible during the
      turn and replaced, not appended. `claude --resume` lists the same
      title. Progress: DONE at the runtime boundary (real Claude Code
      2.1.270 through `createAgentRuntime`): placeholder `source=prompt` at
      turn start, `"Date parser leap year testing" source=harness` during
      the turn, store `titleSource: "harness"` after idle. Rail check on the
      web app not yet run.
- [ ] Codex: after the first turn the rail shows a generated title;
      `codex resume` (thread list) shows the same `name`; the ephemeral
      title thread does not appear in `thread/list`; a session whose title
      turn fails (kill the app-server mid-call) keeps the prompt title and
      logs one warning. Progress: failure path DONE live (real app-server
      accepted `thread/start { ephemeral }` + `turn/start { outputSchema }`,
      turn failed on quota → null, one warning, thread absent from
      `thread/list`). Positive proof BLOCKED: Codex account usage limit
      exhausted until 2026-09-19.
- [ ] Pi: after the first turn the rail shows a generated title that
      arrived as an RPC `session_info_changed` frame (asserted by the
      driver test with a recorded frame); `get_state.sessionName` on the
      live RPC process equals it; the `pi --resume` picker shows it; the
      extension runs the completion with the session's model and auth and
      no second process is spawned. Progress: mechanics DONE live (command
      registered in a real `pi --mode rpc`, dispatched with its args, model
      resolved, completion attempted, no second process). Positive proof
      BLOCKED: Pi's Anthropic OAuth refresh fails on this machine (`pi -p`
      fails identically) and the openai-codex provider is out of quota.
- [ ] Cursor (local): after the first turn the rail shows a generated
      title. Progress: implemented (`cursor/title.ts`), unit-tested with a
      fake agent; not live-verified.
- [ ] ACP (Gemini CLI): an agent that sends `session_info_update { title }`
      wins over generation; an agent that never sends it gets a generated
      title through a temp ACP session that is cancelled on timeout; a
      `session_info_update { updatedAt }` with no `title` leaves the title
      untouched (projection unit test + live). Progress: projection and
      golden tests DONE; `generateAcpTitle` unit-tested; not live-verified.
- [ ] OpenCode: the server's title lands in the rail, including when it
      arrives after `session.idle`; no runtime-generated title is requested
      for OpenCode. Progress: adapter unchanged; not live-verified.
- [ ] Rename is final: rename a session in the rail, send another turn, and
      no `harness` or `prompt` write changes it — asserted by a store test
      (`user` beats `harness` beats `prompt`) and live for one harness.
      A rename inside Claude Code (`/rename` in a resumed session) reaches
      the rail as `user`. Progress: store rank test (`sqlite.test.ts`) and
      runtime test (rename beats a later generated title) DONE; a title
      chosen at create is also user-ranked. Claude `/rename` mapping
      unit-tested (`custom-title` → `user`), not live.
- [ ] Child sessions (subagents) never receive a prompt or generated title;
      `runtime.test.ts` asserts no `session.updated` title frame for a
      session with `parentID`. Progress: enforced in
      `runtime/session-titles.ts` (both placeholder and generation skip
      `parentID`); no dedicated test yet.
- [ ] Row order: a title write (any rank) does not move a row under
      `human_turn_desc`; existing `session-list-events.test.ts` extended
      with a `titleSource: "harness"` frame. Progress: existing client tests
      pass unchanged; no new frame-shape test added.
- [ ] Single owner: `grep -rn "auto-title\|commitSdkAutomaticTitle\|maybeAutoTitle\|generateAITitle\|hasConcreteSessionTitle" packages/*/src`
      returns only `runtime.ts` (`method: "auto-title"`) and the
      `bus.ts`/`app.ts` comments; exactly one `deriveSessionTitle`. Progress:
      DONE (grep returns runtime/session-titles.ts and the two comments).
- [ ] Contract tests: `projection.test.ts` covers `session-info` with and
      without `title` and `session-title` with each `titleSource`; the Codex
      adapter test feeds a real `thread/name/updated { threadId, threadName }`
      frame; the Claude adapter test feeds real `ai-title` and
      `custom-title` entries. Progress: DONE.
- [ ] Gates: `bun run typecheck` per touched package,
      `bun run test:architecture-ratchets` (new production import edges:
      `title-generation.ts`, driver `generateTitle`), the agent-sdk-runtime
      and agent-event-runtime test suites, `claxedo-app` vitest for the
      session sync files. Commands and outcomes recorded in the PR body.
      Progress: typecheck clean on 8 packages; ratchets green (after naming
      two helpers); agent-sdk-runtime 799/0, agent-event-runtime 240/0,
      claxedo-app session-sync 52/0; workspace-runtime 1117/4 where the 4
      are `agent-hooks`/`agent-hook` tests from another lane's WIP commit on
      the branch.

## Non-goals

- Re-titling as the conversation drifts. The rank rule makes it a one-line
  extension (`harness` may overwrite `harness`), but this slice generates
  once, on the first completed turn, matching Claude Code.
- A direct provider call for title generation. Titles go through the
  harness so they use the session's own credentials, model, and sandbox.
- Hosted/cloud sandbox sessions beyond what `publishGlobal` already
  delivers; if the DoD row for a harness fails only on the hosted path,
  record it as a follow-up with the observed frame.

## Execution: parallel lanes with disjoint ownership

Fable subagents only (user ruling 2026-09-14). One owner per lane,
`git commit -- <paths>` per lane on the shared worktree; the orchestrator
reads every diff, re-runs the lane's gate, and runs the live DoD rows
itself.

- Lane C0, contract + store + runtime (lands first): `sessions.ts`,
  `events.ts`, `agent-runtime-event.ts`, `projection.ts`, `memory.ts`,
  `sqlite.ts`, `runtime.ts`, `adapter-contract.ts`, `title-generation.ts`,
  `session-title.ts`, deletion of `sdk-runtime-title.ts` and the two
  `titleEmitted` loops, `hasConcreteSessionTitle` removal. Gate:
  agent-sdk-runtime + agent-event-runtime tests, ratchets.
- Lane H1, Claude: `claude/driver.ts`, `agent-event-runtime/harnesses/claude/adapter.ts`
  + tests (real `ai-title` / `custom-title` fixtures from
  `~/.claude/projects`). Depends on C0's event field.
- Lane H2, Codex: `codex/driver.ts`, `codex/adapter.ts:837` + tests
  (fixtures from `codex app-server generate-ts`). Depends on C0.
- Lane H3, Pi + Cursor: `pi/title-extension.ts`, `pi/driver.ts` (`-e`
  spawn arg, `session_info_changed` ingest), the Pi event adapter mapping,
  `cursor/driver.ts` + tests. Depends on C0.
- Lane H4, ACP: `acp/index.ts`, `acp/turn-runner.ts`, deletion of
  `acp/title.ts`, `projection.ts` `session-info` fix if C0 has not taken it
  (agree before start; C0 owns `projection.ts`). Depends on C0.
- Lane V, client + docs: `inventory-writers.ts` comment,
  `session-list-events.test.ts`, `docs/plans/README.md`. Independent.

C0 first; H1–H4 and V in parallel; the orchestrator runs every live DoD row
after all lanes land, then a Fable adversarial review of the rank rule and
of each `generateTitle` failure path before the branch is called done.
