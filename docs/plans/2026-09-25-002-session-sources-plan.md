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
| Desktop, signed in | the app's one session-source owner in `src/server`, composing exactly two pages: the daemon's local page and the control plane's page, read through the AccountPort operation `session.list` | local projection + the control plane (cloud workspaces, shared machines) |
| Web (hosted or self-hosted) | the control plane (or the self-hosted node) | its own store (D1 or SQLite) |

### 2. Machines publish session rows to the control plane
- A signed-in machine publishes each session's list entry: `sessionRef`, title, `createdAt`, `lastHumanTurnAt`, status, owner and placement. Transcripts are never published.
- It publishes on change and on reconnect, keyed by `sessionRef`; the control plane stores it idempotently.
- This removes the 409: the control plane answers machine sessions from its own store.
- Authorization (creator, participant, share, org role) is applied once, in the control plane's list query.

### 3. One merged cursor
- **Order:** `(lastHumanTurnAt ?? 0 desc, createdAt desc, sessionRef)`, the same everywhere.
- **Keyset pagination:** the cursor carries the last key, and every source reads only rows after it, bounded by `limit`. No full-list re-reads.
- **The signed desktop's merged page:** a two-way merge of the daemon's page and the AccountPort page. The composite cursor holds each source's last key, so the next page is a true continuation, with no gaps and no duplicates. The account credential never leaves Electron main (AccountPort's closed operation set). The daemon never holds a user bearer.
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
- [x] **S1. Control plane:**
  - an idempotent machine-row publish endpoint;
  - a keyset-paged, authz-filtered project list (D1 and the self-hosted SQLite);
  - `latest-surface` and `before` history for cloud sessions;
  - honest reachability.
  - Tests: authz (another user's or another org's rows never appear), keyset continuity (no gaps or duplicates across 3+ pages with concurrent inserts), idempotent republish.
  - Progress: done on `v2/session-sources`.
    - 928d1bba4d: `listSessionPage` (D1 SQL predicate; SQLite keyset walk over its per-row admission), `sessionOrderSql` shared with the local projection, the 409 gone. Session-page conformance on both adapters: other users' and other orgs' rows never appear; a 3+ page walk with inserts and prompts between pages has no gaps or repeats.
    - 585f8f98cb: `POST /api/claxedo/host/session-rows` with the Host Tunnel Token (approved, owner 18:40). Adopts unseen sessions for the enrollment owner; idempotent republish; refuses unserved, superseded-generation, reassigned-host, elsewhere-registered and plane-deleted rows (D1 and SQLite tests; d23b7de590 adds the generation and reassignment cases).
    - d23b7de590: the explicit `after` key / `nextAfter` on every server; `cursor` stays only for v1 and is deleted at the swap.
    - 84f91b15f5: `authorityRowReachable`: machine rows by `host_online` or served here; cloud rows by the ready lease (signed-web's `readyCloudWorkspaces`).
    - f2f74a70a7: `latest-surface` and `latest-turn` views on D1 and SQLite (conformance on both); the app's stored-history first page reads the surface.
- [x] **S2. Machine publisher:** the daemon publishes rows and status on change and on reconnect, bounded with backoff. Tests use a fake control plane; an offline control plane queues nothing unbounded.
  - Progress: 2fa2eaf949 (the URL rides the heartbeat to the daemon), af707f5fbb (publisher: coalesced, 250 ms debounce, 100-row chunks, 1 s→60 s jittered backoff, a 1000-session cap that collapses to one full resync, a 401 waits for the next credential), ca5d7c95c3 (change notices come from the projection's own writers; an unreadable row backs off). Tests against a fake control plane, including a real daemon booted in-process.
- [ ] **S3. Signed desktop merged list through AccountPort:**
  - add `session.list` to the closed `HostedOperationName` set and to Electron main's route table;
  - the guard tests hold the registry and main equal;
  - the app's session-source owner merges the daemon page and the account page with a composite cursor;
  - when the account source fails, the page is the local rows plus a `degraded` marker, never a failure;
  - no bearer is ever pushed to the daemon.
  - Progress: blocked on `lane-desktop-account` (the v2 AccountPort owner, `session.page`, the signed desktop catalog and project link). The server contract it calls is ready (`scope=project`, `after`, `nextAfter`); the two-source merge in `src/server` follows its port.
- [ ] **S4. App switch:**
  - `src/session/list` reads one page per project from one endpoint;
  - status comes from events;
  - the per-placement fan-out, per-placement tails and `Promise.all` are deleted;
  - the rail is a true prefix of the order.
  - Flows: prefix order across mixed sources, "Show more" continuity, one failed source not blanking the rail, and 0 sandbox-wake requests at boot.
  - Progress: done for unsigned desktop and the web; the signed desktop's two sources wait on S3.
    - 125e0bce4b, 1fadb6854f, cb48ece993: the daemon lists one keyset page per project, each row carrying its runtime's status read in process.
    - ac41cbea48: one list read per project; per-project windows, more-state and page failures; status from rows and events; the fan-out, the tails, `sessions.statuses()` and `/api/wr/session-activity` deleted.
    - Flow 38: true prefix across a folder and its worktree at every Show more; one list read per project and no status, permission, question or wake at boot; a failed project page leaves the others and retries. Flows 10, 31 (paint case rewritten), 33, 12 and 00-signed-smoke pass.
    - Boot, before: one list read per reachable placement plus `/api/wr/session-activity` on loopback, or three runtime reads per remote placement. After: one list read per project and nothing else.
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
