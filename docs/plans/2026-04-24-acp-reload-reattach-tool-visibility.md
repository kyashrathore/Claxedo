# ACP reload reattach and tool visibility

## Why this exists

The current ACP integration can leave users unsure about two important states:

- after a browser reload during an active ACP turn, whether the frontend has reattached to the live backend turn or is only showing old journal output;
- after Codex ACP edits files through shell commands, whether any file changes actually happened, because no patch/edit UI row appears.

This artifact is based on the inspected Codex ACP journal:

`/Users/yashvardhansingh/.claxedo/agent-core/1cb37d5f-d750-4903-a8ef-e86bc94c599b/__type___codex-acp___binary____Users_yashvardhansingh_test_opencode_packages_workspace-runtime_node_modules__bin_codex-acp__/sessions/d3309e77-6ed9-4030-b498-139552d97fc9.jsonl`

## What happened in that session

The user asked Codex ACP to adjust workspace panel behavior. The session did make and attempt changes in the Claxedo app, but it did not emit any ACP-native patch/edit/diff message parts. It used shell tools, including `bun -e`, to write files.

That is why the UI showed shell rows and no patch/edit row. The translator cannot render a patch card from an event that was never emitted.

The session also had several tool failures:

- `rg` failed because zsh expanded unmatched glob paths before `rg` ran.
- A `bun -e` scripted edit failed because TSX containing `` `${panelWidth()}px` `` was embedded inside an outer JavaScript template string.
- Direct `bun test` path filters failed for `.vitest.tsx` until paths were prefixed with `./`.
- Direct `bun test` then ran Solid testing-library code in server mode.
- The intended UI test runner hit an existing Vitest/tinypool serialization failure.

The session later used different shell commands and typecheck/diff-check style validation, but the UI still lacked a clear "files changed" affordance.

## Root causes

### Reload and active turns

The browser's live state depends on an SSE subscription and in-memory optimistic state. A reload creates a fresh frontend instance. Without durable active-turn state and explicit reattachment semantics, the frontend can only replay persisted journal events and subscribe to future events. It cannot reliably know whether a backend ACP turn is still live, stale, failed, or idle unless the runtime persists and serves that state.

Increasing SSE heartbeat from 30 seconds to 2 minutes reduces disconnect churn, but it does not solve reload. A reload intentionally drops the old EventSource and creates a new one.

### Missing patch/edit UI

ACP agents do not always emit native patch/edit events. Codex ACP can edit through shell commands. In the inspected journal, there were no `diff`, `patch`, `edit`, or `metadata.acp.intent === "edit"` parts. The only evidence was shell command text and later git/typecheck commands.

The UI needs an agent-agnostic fallback: when a turn changes files but no native patch/edit event exists, show changed-file evidence from the workspace runtime.

## Recommended design

### 1. Durable active-turn state

Persist turn state keyed by directory, session id, and turn id:

- `queued`
- `running`
- `idle`
- `error`
- `stale`
- `recovering`

On frontend load, fetch the latest journal plus active-turn status. The send box should derive busy/idle from this durable state after hydration, not only from optimistic local reducer state.

### 2. Reattach as subscriber, not replay-as-new

Reloading the browser should:

- subscribe to the session event stream;
- replay persisted journal events as historical state;
- attach to the current live turn if one exists;
- avoid sending a duplicate prompt;
- mark the session stale if the backend process died while the UI was disconnected.

### 3. Pending prompt liveness

Permission and question prompts need explicit liveness:

- live prompt: resolver/session is alive, user can answer;
- stale prompt: backend process or resolver is gone, user sees expired state and retry guidance;
- replayed prompt: historical only, not clickable.

### 4. Changed-file evidence for shell edits

At turn start, record a lightweight workspace snapshot. At tool end or turn end, compute changed-file evidence scoped to the active workspace:

- changed file paths;
- status per path where possible;
- optional `git diff --stat`;
- optional hunks only when cheap and safe;
- source metadata: native edit event, shell evidence, or runtime diff snapshot.

When no native patch/edit event exists, emit or attach degraded visible evidence using existing event shapes. Preserve raw command and output under metadata.

### 5. Keep native ACP events first

If an ACP agent emits a patch/edit/diff event, render it normally. The runtime changed-file evidence is a fallback and a confidence aid, not a replacement for native tool output.

## Tests to add

- Browser reload during active ACP turn rehydrates busy state and does not duplicate prompt submission.
- Browser reload after backend process death marks prompts stale.
- `session.error` and `session.idle` release optimistic busy state.
- Shell-scripted file writes produce visible changed-file evidence when no native patch event exists.
- Native patch/edit events continue to render without duplicate synthetic rows.
- Pre-existing dirty files are not attributed to the current turn unless they changed during the turn.
- Replay/load fallback marks replayed output so downstream reducers can avoid duplicate UI where possible.

## Follow-up todo

Tracked as:

`.context/compound-engineering/todos/001-ready-p1-acp-reload-reattach-and-tool-visibility.md`
