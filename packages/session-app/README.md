# @claxedo/session-app — the dual-target session UI slice

One session UI, authored once around the harness-agnostic `AgentRuntimeEvent`
contract, running in the browser directly (Solid 2) and compiling to a native
binary (Native SDK). Local, unsigned, unauthed, against the real Claxedo
local server. This package is the living proof for
`docs/plans/native-sdk-port/03-dual-target-composition.md`.

## Quickstart (local machine)

```bash
git fetch origin claude/claxedo-perf-optimization-1yzgej
git checkout claude/claxedo-perf-optimization-1yzgej
bun install
packages/session-app/dev/run.sh            # or: dev/run.sh /path/to/any/git/repo
```

First run builds the embedded engine artifact (~1 min), then serves the app
at http://localhost:4460 against the real local server on 127.0.0.1:4480 and
prints the exact URL to open. Requires bun + node 20+.

## Layout

- `src/core/` — the shared Elm-shaped core: model, `update`, runtime-event
  fold, transcript decoding. Dependency-free; identity-preserving for
  untouched rows (pinned by tests); type-checked against the canonical
  `AgentRuntimeEvent` union by `contract.test.ts`. `bun test ./src`.
- `src/client/` — local-server client: workspace resolve (create=true),
  `/session` list/create, transcript, prompt (carries the composer selection
  as `SessionPromptBody` fields: `model`, `agent`, `variant`,
  `permissionMode`), `/api/wr/runtime-events` SSE with reconnect. Plus
  `composer-client.ts`: harness roster + active harness, harness model/effort
  options, `/provider` catalog, permission modes, workspaces, worktree
  list/create, credential providers + API-key put (endpoints verified live —
  see `docs/api-verification.md`).
- `src/web/` — Solid 2 (2.0.0-rc.0) renderer: `run-core.ts` bridges the pure
  core into a store (authoritative model outside the store — writes commit on
  microtasks; keyed field-level diff so `<For>` keeps row DOM during
  streaming). `npm/bun run dev`, then
  `?server=http://127.0.0.1:PORT&directory=/abs/git/dir`.
- `dev/fake-runtime-server.mjs` — scripted wire-compatible runtime replaying
  a full streamed turn (deterministic streaming verification).
- `dev/start-real-local-server.ts` — boots the REAL desktop-local server
  composition (embedded engine + workspace runtime) under node+tsx
  (`bun` segfaults in this container; run from `packages/workspace-runtime`
  for tsx resolution).
- `native/` — the Native SDK app (`native check` clean end to end; builds a
  Linux binary with `native build --yes` once `libgtk-4-dev` is installed).

## Verified (2026-08-14, this container)

- Web vs fake runtime: transcript markdown, live SSE, streamed turn
  (thinking/text deltas/tool lifecycle/todos/finish), composer round trip —
  playwright-driven, zero console errors.
- Web vs REAL server: workspace create, real session create, live
  `/api/wr/runtime-events`, real embedded-engine turn streaming into the
  timeline.
- Native core vs REAL server (`native dev --core`): the compiled-core logic
  loop executed the real sync service (curl) — workspace resolve + session
  list + transcript in 49ms — and seeded its model with the very message the
  web app had sent earlier. Same server, same session, both frontends.
- Native binary: builds (22 MB ReleaseFast) and runs under xvfb — view
  wired, poll subscription firing.

## Known limits / next steps (exact state)

1. **Native runtime segfault (blocker)**: on Linux the running binary
   crashes ~1s after launch, coinciding with the first service Cmd dispatch
   (SDK 0.9.0; our core is pure data). Isolate with a no-service core (drop
   the boot/tick Cmds — if it stays up, it's the service carrier), then file
   upstream with the repro. `native automate screenshot` is ready once it
   stays up.
2. Native liveness is 1s polling: services are sync-only today and scriptc
   projects no stream-fd access, so the SSE bridge can't be a service yet.
   Async services (their roadmap) or a core-side channel decoder unlocks
   token-grained native streaming.
3. `@native-sdk/core/text`'s engine fails the external core compiler's
   integer proofs (SC4022/SC4023) in 0.9.0 — the core imports the TYPE only
   and carries a minimal caret-at-end editor.
4. Web fold refinement: handle `user-message-delta` explicitly (engine
   echoes the user message; currently lands as assistant text).
5. Markup findings for the dual-target emitter: no `else-if`; `and`/`or`;
   no `!` (spell `== false` — accepted by the validator but the RUNTIME
   binds only bare fields, so precompute booleans in the core); iteration is
   `<for each key as>`; text controls bind `text="{bytes}"` and `on-input`
   requires the canonical `TextInputEvent` (type-only import works).

## Parity status (2026-08-15)

Verified live against the real local server (playwright-driven):
- Harness roster chip: all 8 harnesses (ACP/SDK/native classes), active one
  auto-selected.
- Model picker: real `/provider` catalog (5 configured providers), sticky
  provider groups, selection carried into the prompt body (`model
  {providerID, modelID}`).
- Effort: thought-level options for harnesses exposing them; model-variant
  efforts for catalog models are decoded (`decodeModelVariants`) — UI wiring
  for variant efforts on catalog models is the next slice.
- Permission modes: per-harness modes render and select when the harness
  reports them (hidden when unsupported, like the real app).
- Project chip: real workspaces (local + cloud access kinds).
- Worktree chip: list + "+ New worktree" create through the real compat
  routes.
- Provider setup: `putCredential`/`listCredentialProviders` are wired and
  live-tested in the client; the API-key entry UI hangs off the model picker
  next.

Known deltas from exact-pixel parity (tracked, spec'd in
docs/visual-spec.md): the merged picker lacks the model search field, and
the timeline uses the simplified row set rather than the full
BasicTool/turn-fold chrome. Menus are portaled (@solidjs/web Portal) with
trigger-anchored fixed positioning, and the card keeps its spec-correct
`overflow: clip`.
