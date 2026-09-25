# Session sources: one merged list per server, history without live runtimes

Status: approved by the owner on 2026-09-25 ("go ahead with session design changes"). Builds on DECISIONS "Owner, 2026-09-25 16:20: dead-sandbox session flow".

## Why (observed on feat/app-v2, 2026-09-25)
- v2 sends one list request per placement to the single server it's attached to, then merges the pages in the browser (`src/session/list/reads.ts:45-57`, `src/server/session-reads.ts:32-35`). Nothing merges sources on the server.
- **Desktop, signed in:** the rail is the same as signed out. The daemon never merges control-plane sessions (cloud workspaces, shared machines). v1 did (`claxedo-app/.../session-source.ts:95-126`).
- **Hosted web:** the bootstrap carries no placements (`claxedo-server/src/routes/hosted/shell.ts:716-724`), so the rail is empty. Machine placements get a 409 `workspace_runtime_session_authority` (`claxedo-server/src/session/list.ts:108-116`), and one failure blanks the whole list, because `Promise.all` (`reads.ts:56`) has no per-placement tolerance.
- **Paging:**
  - Each placement is cut at its own tail, so the visible list isn't a prefix of the true order (`visible-rows.ts:35`).
  - Boot costs N list reads plus about 3N status reads, and "Show more" costs N.
  - The signed list re-reads a workspace's whole list on every page (`navigation-list.ts:190-203`).
- **History and status** always go to the live runtime, which wakes cloud sandboxes and fails when they're gone.
- **Terminals** are read per placement, for every placement signed catalogs call reachable, and signed catalogs call every placement reachable.

## Design

### 1. One list owner per connection
The app asks one server for one page of a project's sessions, with one opaque cursor. It never fans out per placement.

| Connection | List owner | Sources it merges |
|---|---|---|
| Desktop, signed out | the daemon | the local projection |
| Desktop, signed in | the daemon | the local projection, plus the control plane's page for the user's cloud workspaces and shared machines |
| Web (hosted or self-hosted) | the control plane (or the self-hosted node) | its own store (D1 or SQLite) |

### 2. Machines publish session rows to the control plane
- A signed-in machine publishes each session's list entry: `sessionRef`, title, `createdAt`, `lastHumanTurnAt`, status, owner and placement. Transcripts are never published.
- It publishes on change and on reconnect, keyed by `sessionRef`; the control plane stores it idempotently.
- This removes the 409: the control plane answers machine sessions from its own store.
- Authorization (creator, participant, share, org role) is applied once, in the control plane's list query.

### 3. One merged cursor
- **Order:** `(lastHumanTurnAt ?? 0 desc, createdAt desc, sessionRef)`, the same everywhere.
- **Keyset pagination:** the cursor carries the last key, and every source reads only rows after it, bounded by `limit`. No full-list re-reads.
- **The daemon's merged page (signed desktop):** a k-way merge of the local page and the control-plane page. The cursor is the last emitted key, so the next page is a true continuation, with no gaps and no duplicates.
- **Dedup is by `sessionRef`,** never by bare `sessionId`. A session has exactly one placement.

### 4. Status by events, not reads
- List rows carry the last known status.
- Changes arrive on the event stream the app already reads: from the daemon for local sessions, and from the control plane's stream for cloud and machine sessions (machines publish status with their rows).
- The rail never reads `/session/status`, `/permission` or `/question` per placement.
- No list or status path wakes a sandbox.

### 5. History
- **Cloud sessions:** the control plane (D1), with `latest-surface` and `before` paging implemented there. Rendering needs no live sandbox; the dead-sandbox flow (DECISIONS 16:20) wakes on send.
- **Machine sessions:** read live from the machine over the relay. When the machine is offline, the session shows its published row and a "machine offline" state, with no errors.
- **Local sessions:** the local runtime.
- One routing owner on the app side (`src/server`) decides per placement. There's no per-component routing.

### 6. Honest reachability
- The server that knows a placement's state computes it: sandbox ready, machine online, or local.
- Signed catalogs stop hard-coding `reachable: true`.

### 7. Terminals
- They exist only while their runtime lives, so they're read only for live placements, when their project is expanded.
- No paging.
- A gone sandbox or an offline machine shows no terminals.

## Phases and acceptance
- [ ] **S1. Control plane:**
  - an idempotent machine-row publish endpoint;
  - a keyset-paged, authz-filtered project list (D1 and the self-hosted SQLite);
  - `latest-surface` and `before` history for cloud sessions;
  - honest reachability.
  - Tests: authz (another user's or another org's rows never appear), keyset continuity (no gaps or duplicates across 3+ pages with concurrent inserts), idempotent republish.
  - Progress:
- [ ] **S2. Machine publisher:** the daemon publishes rows and status on change and on reconnect, bounded with backoff. Tests use a fake control plane; an offline control plane queues nothing unbounded.
  - Progress:
- [ ] **S3. Daemon merged list (signed desktop):** a k-way merge with an opaque cursor over local and control-plane pages. When the control plane is unreachable, the page is the local rows plus a `sources.degraded` marker, never a failure.
  - Progress:
- [ ] **S4. App switch:**
  - `src/session/list` reads one page per project from one endpoint;
  - status comes from events;
  - the per-placement fan-out, per-placement tails and `Promise.all` are deleted;
  - the rail is a true prefix of the order.
  - Flows: prefix order across mixed sources, "Show more" continuity, one failed source not blanking the rail, and 0 sandbox-wake requests at boot.
  - Progress:
- [ ] **S5. History routing:** one owner in `src/server` routes by placement kind (control plane, relay or local), and offline machines render the published row.
  - Flows: a gone cloud sandbox renders its history; an offline machine renders its row and state.
  - Progress:
- [ ] **S6. Terminals:** live placements only, lazy per project.
  - Flow: a gone sandbox shows no terminal rows and makes no PTY request.
  - Progress:

## Definition of done
- [ ] In every mode (desktop signed out, desktop signed in, hosted web, self-hosted web, shared machines), the rail lists the right sessions in one true order, with working "Show more", proven by flows.
- [ ] Boot makes one list request per visible project and zero per-placement status reads, and wakes no sandbox.
- [ ] Opening a cloud session with its sandbox gone renders its history, and send wakes it (the 16:20 flow).
- [ ] An offline machine never blanks or errors the rail.
- [ ] Per-placement list fan-out code is deleted from the app, and the line count drops.

## Execution
- **Lanes by file ownership:**
  - control plane (`packages/claxedo-server`, and server-core's list and authority);
  - daemon (`packages/claxedo-local-server`: the publisher and the merged list);
  - app (`packages/claxedo-app-v2/src/server`, `src/session/list`, rail).
  The app lane goes last and consumes the others' contracts.
- **Coordination with running lanes:** session-screen owns the list store's granularity, and signed-web owns the dead-sandbox flow.
- **Runtime test suites** run only under the no-signal `sandbox-exec` profile.
