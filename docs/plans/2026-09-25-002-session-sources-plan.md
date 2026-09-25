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
| Desktop, signed in | the app's one session-source owner in `src/server`, composing exactly two pages: the daemon's local page and the control plane's page, read through the AccountPort operation `session.page` | local projection + the control plane (cloud workspaces, shared machines) |
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
  - add `session.page` to the closed `HostedOperationName` set and to Electron main's route table;
  - the guard tests hold the registry and main equal;
  - the app's session-source owner merges the daemon page and the account page with a composite cursor;
  - when the account source fails, the page is the local rows plus a `degraded` marker, never a failure;
  - no bearer is ever pushed to the daemon.
  - Progress: code done; the paired-project flows are open.
    - The port, `session.page` and the account catalog (`Workspaces.accountProjectIds`) are lane-desktop-account's (e32ce4033c).
    - 403e9ff7ae: `src/server/session-list.ts` composes the daemon page and one `session.page` per paired account project. `session-sources.ts` merges them with the shared `after` key (`wire/list-order.ts`), dedupes by `sessionRef` and slices to `limit`. A failed account source makes the page local rows plus `degraded`, and the rail shows a Retry notice. An account-only project's page is required, so a failure there is a page failure. Unit tests: `session-sources.test.ts` (one order under one key, sessions created between pages, dedupe, degraded, a failed daemon page fails, the key round trip) and `session-list.test.ts` (source selection per project kind, an account-only failure, a paired project degraded). The daemon request carries no account credential; only Electron main holds it.
    - Flow 39 (@desktop): an account-only project lists the account's first five sessions in the account's order beside a local project, and Show more continues to all seven. Red with the account source removed (the account project's rows stay empty), green with it. Flow 21 passes with its sign-in moved into `signInDesktop`.
    - Open, with S5's offline-machine flow (one harness item): "local and account rows in one true order in one project" and "a failing account page shows the local rows plus the degraded notice". Both need a paired project. The unit tests above cover them until then.
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
  - Progress: the router is signed-web's `readHistory`/`onRuntime` in `session-reads.ts` (control plane for cloud, runtime or relay otherwise). e7a2dda260 adds the offline-machine branch: its row from the published inventory, no transcript, nothing read from the machine, and a "machine offline" card. f2f74a70a7 serves the stored transcript's `latest-surface`. Proven by `session-reads.test.ts` (stopped cloud and offline machine), flow 24 (signed-web: a gone sandbox renders from the control plane and nothing wakes it) and flow 38's stopped-sandbox case (the stored surface read, no runtime read, no wake, no terminal list). The offline-machine flow is an open item (owner: a relay/remote-access harness lane), shared with S3's two paired-project flows. Unit coverage stands in until then. A paired project is a desktop workspace the control plane also serves, and no e2e path makes one without an enrolled host. The flows need:
    1. a second daemon (local-server or self-hosted node) enrolled against the signed stack as a machine (invitation redeem or account enrollment with the connector);
    2. one of its workspaces assigned and acked, so `host_online` is true, the relay tunnel is up and the S2 publisher pushes its rows with the tunnel token;
    3. the owner's browser listing that project;
    4. that daemon stopped and its lease left to expire (or the enrollment paused), so `host_online` turns false; then assert the row still renders, the "machine offline" card shows, and no request reaches `/workspaces/<id>/`.
    5. for S3: a signed desktop with that workspace also open locally, sessions created on both sides, then the one-order and Show-more assertions, and the degraded notice once the account page fails.
- [x] **S6. Terminals:** live placements only, lazy per project.
  - Flow: a gone sandbox shows no terminal rows and makes no PTY request.
  - Progress: 3d5d1d48c1: terminals are read only for an expanded project's live placements (reachability is honest since 84f91b15f5). Flow 38 counts PTY reads at boot and on expand; flow 13's "a workspace whose folder is gone reads no terminal list" covers an unreachable placement. Flow 38's stopped-sandbox case proves no PTY read for a stopped sandbox.

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
