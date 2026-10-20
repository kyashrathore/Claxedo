# The control plane at the edge over D1 read replicas, 20 October 2026

A signed browser read from India no longer crosses to IAD: the control plane is now two Workers from one bundle, an edge Worker with no placement that answers bookmark-carrying reads from the nearest D1 read replica, and the existing Worker pinned beside the databases as the writer, which runs every request that may write. The edge hands those requests to the writer over a service binding before it composes or authenticates anything, so a write pays today's path (client → SIN edge → IAD) and the writer's rounds stay beside the primary. Expected from the cold-start note's numbers: a warm signed read 0.42–0.60 s → about 0.14–0.33 s, a cold one 0.85 s → about 0.2–0.4 s, a write unchanged within the edge invocation it adds (0.15 ms of wall time on local workerd). This note is the design, the per-route classification, what changed, what the owner runs on Cloudflare, and what only staging can confirm. Every platform claim cites developers.cloudflare.com.

## Platform facts

- **Replicas.** "D1 automatically creates a read replica in every supported region": ENAM, WNAM, WEUR, EEUR, APAC and OC; the regions are "subject to change at Cloudflare's discretion", and APAC names no city ([read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)). Which APAC data center answers a request from India is not documented; `served_by_region` on staging will say (below). With a jurisdiction, "read replicas are only created within the jurisdiction" ([data location](https://developers.cloudflare.com/d1/configuration/data-location/)); staging sets none.
- **Enabling and cost.** Per database, in the dashboard (the database's Settings) or `PUT /accounts/{account_id}/d1/database/{database_id}` with `{"read_replication": {"mode": "auto"}}` and a D1:Edit token; no Wrangler command. "You don't pay extra storage or compute costs for read replicas"; disabling "takes up to 24 hours for replicas to stop processing requests" ([read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)).
- **Without a session nothing changes.** "To use read replication, you must use the D1 Sessions API, otherwise all queries will continue to be executed only by the primary database"; "All write queries are still forwarded to the primary database instance" (same page). So the Durable Objects and every path that reaches a bare binding keep reading the primary.
- **Sessions.** `withSession("first-primary")` "directs the first query in the Session (whether read or write) to the primary"; `"first-unconstrained"` (the default) "to any database instance"; a bookmark starts a session "at least as up-to-date as the provided bookmark" ([D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)). Later queries of either "go to any replica that is consistent with the bookmark maintained by the session" (`D1SessionConstraint` in `@cloudflare/workers-types`). A session has `prepare`, `batch` and `getBookmark`, which "returns `null` if no query is executed"; no `exec`. "All queries in a session ensure sequential consistency", including "Read my own writes" ([read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)). A bookmark travels between requests however the application carries it; the docs' example is an `x-d1-bookmark` header.
- **Bookmarks.** "Bookmarks are lexicographically sortable. Sorting orders a list of bookmarks from oldest-to-newest"; "Bookmarks older than 30 days are invalid" ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)). The format is undocumented; the one shown is `00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683`, which Miniflare's local D1 also produces.
- **Observability.** "`served_by_region` and `served_by_primary` fields are present for all D1 remote requests", undefined under local development ([read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)).
- **Placement.** With none, Workers "run in a data center closest to where the request was received"; "Placement only affects the execution of fetch event handlers", not RPC or named entrypoints, and the documented split is "Enable placement on your back-end Worker to invoke it close to your database" ([placement](https://developers.cloudflare.com/workers/configuration/placement/)). A service binding's callee runs "on the same thread of the same Cloudflare server" by default ([service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)), so the session host's Durable Objects (location hint `enam`) still reach the writer beside the primary.
- **Durable Objects.** An object "is instantiated in a data center close to where the initial `get()` request is made", does "not currently change locations after they are created", and `locationHint` is respected on the first `get()` only, "a best effort and not a guarantee" ([data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)).
- **Routes.** A Worker's routes are zone-level (`GET`/`DELETE /zones/{zone_id}/workers/routes[/{route_id}]`, [API](https://developers.cloudflare.com/api/resources/workers/subresources/routes/)). Wrangler 4.114 deploys a Worker's routes only when none is "assigned to another worker", and a Worker deployed with no routes keeps the ones it had (it skips the routes call), which is why the first deploy moves them explicitly.

## Why two Workers

A single edge Worker would answer reads near the person and pay every write round across the ocean. A `first-primary` session sends its first statement to the primary and the rest to a replica "consistent with the bookmark", which right after a write is the primary or a wait for the replica. From SIN each such round costs about 0.23 s against 0.035–0.05 s beside the primary (`d1-signed-reads-2026-10-18`), so a signed write of R rounds goes from about 0.36 + 0.04·R s to 0.12 + 0.23·R s: worse from two rounds on, and a sandbox key save (seven rounds) from about 0.64 s to 1.7 s. The writer keeps those rounds in IAD.

## How a request runs

1. The browser, desktop, a machine, the relay or a sandbox sends a request to a control-plane path on `app.claxedo.dev`. The route belongs to the edge Worker (`renderEdgeWorkerWranglerConfig`), which runs in the data center that took the request.
2. `createBetterAuthD1Worker().fetch` (`deployments/hosted-workerd/better-auth-d1-worker.cf.ts`) asks `d1SessionStart(request)`, the one classifier:
   - **`replica`**: a GET or HEAD not listed in `PRIMARY_READS` and not redeeming an owner claim, from the browser (its Better Auth session cookie), from a client that echoes `x-claxedo-d1-bookmarks` (the desktop after its first answer), or from nobody (the health probe, the descriptor, public metadata).
   - **`primary`**: every other method; the reads in `PRIMARY_READS` (OAuth callback, password reset, email verification, account deletion, an OAuth client's sign-out, the device page, OAuth authorize, a connection attempt's poll and callback, a connection's token and repositories, the plugin MCP gateway, the egress broker, `/internal/*`); a request carrying the owner-claim header; and a GET on a bearer token that echoes no bookmark.
3. On the edge a `primary` request goes to `forwardToWriter`, which calls `env.CONTROL_PLANE_WRITER.fetch(request)` and appends `forward;dur=` to the writer's own `Server-Timing`. Nothing on the edge composes, authenticates or rate-limits it. If the writer throws, the edge answers 503 `deployment_candidate_unavailable`, the code the clients retry.
4. Otherwise, and on the writer, `timedResponse` wraps `inD1Sessions(request, start, respond)` (`platform/db/d1-sessions.ts`). It reads the request's bookmarks from the `__Host-claxedo.d1-auth` / `__Host-claxedo.d1-control` cookies and the header (the newer wins), and holds one scope per request in `AsyncLocalStorage`.
5. Every database the composition holds is `workerDatabases(env)`: `timedD1(requestSessionD1(binding, name))`. Its `prepare` and `batch` open the scope's session for that database on the first statement: `withSession("first-primary")` for `primary`, `withSession(bookmark ?? "first-unconstrained")` for `replica`. Outside a scope (a Durable Object's own work) the bare binding answers, which is the primary.
6. When `respond` settles, every answer whose sessions ran a statement names their bookmarks in `x-claxedo-d1-bookmarks`; a `primary` answer also sets them as cookies (`Path=/; Max-Age=300; Secure; SameSite=Lax`). A `replica` answer sets no cookie: the browser keeps whichever cookie arrives last, and a read's bookmark can be older than the one a concurrent write is about to set.
7. Another actor's write reaches a reader through live sync. `nudgeLiveSyncRoom` stamps every event with `d1Bookmark`, the publisher's session bookmark past the write it announces; the room admits it when it is a bookmark. The provisioner's alarm writes on the bare binding, so its notice runs its owner read in a `primary` scope of its own (`machine-notice.ts`), whose bookmark covers those writes. The browser's `/api/cp/events` reader raises the control cookie to a newer bookmark before the frame's re-reads go out (`raiseD1BookmarkCookie` in `@claxedo/agent-runtime-contract`, called from `claxedo-app/src/server/streams.ts`); the desktop's main process raises its jar the same way while it forwards the stream (`claxedo-desktop/src/main/account/d1-bookmark-jar.ts`), and echoes the newest bookmarks on every call, lapsing them after 300 s as the cookie does.
8. The writer, the session host and the relay are unchanged in what they decide. New sandbox provisioner objects are hinted to the control-plane database's region (`CLAXEDO_D1_PRIMARY_LOCATION`, set by the deploy from `wrangler d1 info`), so a workspace first touched from the edge is not created in Asia and then pay every D1 round from there.

State: the bookmark the browser carries lives in its cookie jar, shared by its tabs; the desktop's in its main process; the server keeps none. The databases stay authoritative; a session decides only where a read is answered from.

## Per route

Rounds are serial D1 rounds as `countD1Rounds` pins them (`better-auth-d1-signed-rounds.d1.test.ts`, `signed-read-rounds.d1.test.ts`, `runtime-session-authority.turn-start.test.ts`, `workspace/harness-runtime.d1.test.ts`, `connections/hosted-d1/setup.test.ts`); a cookie-signed request adds two (session ⋈ user, then evidence ‖ identity), included below; one admitted on a principal the browser principal cache holds ([session-cache-2026-10-20](../session-cache-2026-10-20/README.md)) pays neither, on the edge as on one Worker. The session layer adds no statement. "Today" is 0.36 s of client ↔ IAD on a reused connection plus 0.035–0.107 s per round; "edge read" is about 0.12 s client ↔ SIN plus one replica round per serial round (unknown until staging, taken here as 5–70 ms); "via writer" is today's path plus the edge invocation.

| route (caller) | runs | start | rounds | today (s) | after (s) |
|---|---|---|---|---|---|
| `GET /api/auth/get-session` (browser) | edge | replica | 1 | 0.40–0.47 | 0.13–0.19 |
| `GET /api/workspace?host=provisioner`, `/shared-sessions`, `/remote-access/devices` (browser) | edge | replica | 3 | 0.47–0.68 | 0.14–0.33 |
| `GET /api/control/session-list?scope=projects` (browser) | edge | replica | 4 | 0.50–0.79 | 0.14–0.40 |
| `GET /api/claxedo/credentials`, `/effective` (browser) | edge | replica | 4 | 0.50–0.79 | 0.14–0.40 |
| `GET /api/workspace/:id/connection` (browser; writes a token record) | edge | replica | 4, one a write | 0.50–0.79 | 0.4–0.6 (the write crosses to ENAM) |
| `GET /api/claxedo/bootstrap`, `/auth/descriptor`, `/health` (anyone) | edge | replica | 0 | 0.36 | 0.12 |
| `GET /api/cp/events` (browser, stream) | edge | replica | 3 at start, 3 every 30 s | — | — |
| `PUT /api/claxedo/credentials` sandbox key (browser) | writer | primary | 7 | 0.60–1.1 | same + edge invocation |
| `PUT /api/claxedo/credentials/sandbox-drivers/default` (browser) | writer | primary | 6 | 0.57–1.0 | same |
| `POST /api/workspace/create`, `/:id/connection` (browser) | writer | primary | 4+ | 0.50+ | same |
| `POST /api/control/session-registrations/reserve` (browser, desktop) | writer | primary | about 7 (read from the code, unpinned) | 0.60+ | same |
| `GET /api/auth/callback/github` (browser) | writer | primary | 6 | 0.57–1.0 | same |
| `GET /api/auth/device`, `/oauth2/authorize`, `/api/claxedo/integrations/attempts/:state` (browser) | writer | primary | — | today | same |
| `POST /api/runtime-authority/session-authorize` `turn_acquire` (session host) | writer, from ENAM | primary | 5 | DO ↔ IAD | unchanged |
| `GET /internal/relay/target`, `/host-generation`, `/revocation` (relay) | writer | primary | 1–3 | today | same + edge invocation |
| host connector heartbeat, acquire, session rows (machine) | writer | primary | — | today | same |
| desktop calls after its first answer | edge for GET, writer otherwise | as the browser | — | today | reads as the browser |

`d1-session-classifier.test.ts` builds the full-hosted Agent Plugins composition and Better Auth's endpoints, and fails on any GET route that is neither in `PRIMARY_READS` nor in its reviewed list of replica reads, each with the reason it is safe (it writes nothing, or nothing a later replica read depends on).

## Measured locally

The local stack has one D1 database per binding, so a replica, its lag and every network hop are invisible; what it shows is that the split routes, carries and costs what the design says.

- `split-rig.ts` beside this file, the built plain user-deployed bundle as edge and writer under local workerd (on dev 138854b173 with this branch, an e2e run sharing the machine; 60 samples each after five warm-ups): a bookmarked read at the edge (`GET /p/:token`, one D1 read) 2.55 ms wall p50, server `total` 1 ms; a write through the edge (`POST /api/auth/sign-in/social`, which writes a verification row) 3.78 ms; the same write on one Worker with no edge 3.63 ms. The forward costs 0.15 ms of wall time, and `forward` less the writer's `total` reads 0 at workerd's 1 ms timer resolution. Each forwarded answer carries one `auth` entry and one `compose` mark, the writer's.
- `better-auth-d1-worker.d1-sessions.d1.test.ts`: a sign-up through the edge composes once, on the writer; the next read starts its auth session at the bookmark the sign-in handed back and sees the account; a read without one starts unconstrained; an unreachable writer answers 503.
- The same test, with the principal cache: a write forwarded to the writer answers the same status and the same principal-cache cookie as the writer answering it directly, and an edge read admitted on that cookie opens no auth-database session.
- `d1-sessions.d1.test.ts`: the cookie's attributes; header and cookie merge to the newer; a malformed or foreign value is ignored; one session per database per request, batches included; no cookie on a read or on a request that ran nothing; the cookie joins Better Auth's own cookies and survives an immutable redirect.
- Signed e2e on web and phone and the desktop sign-in run the Miniflare stack as the same two Workers (`hosted-miniflare.ts` renders both configs; the edge answers the port and binds the writer), so every write in them went through the forward.

## What only staging proves

- Which data center answers India's reads, and the replica round's cost: `d1-served;desc="APAC-replica"` in `Server-Timing` names it, from `served_by_region`, on every result that carries `meta` (`first()` carries none).
- Replica lag and how a bookmarked session waits for it; how D1 treats a bookmark ahead of the database (the cookie's 300 s life keeps one from surviving a staging reset).
- The write path's real cost: `forward;dur` minus the writer's `total` is the SIN ↔ IAD hop plus the writer's invocation; expected about 0.23 s, the hop today's routed request already pays.
- The edge's cold rate where it runs and the writer's behind a service binding, which the cold-start note measured at about half on a quiet staging.
- The first deploy's route move and the window between the writer's deploy and the edge's.
- Any vendor call a replica-classified GET makes now leaves from the edge's data center instead of IAD; its `upstream-host` entries in `Server-Timing` name them, and a vendor that refuses some region would answer differently there.

## The owner's Cloudflare steps

1. Enable replication on both staging databases. Their ids are in `bunx wrangler d1 list --json` (names `claxedo-acc-auth-stg-260830-232009-3851` and `claxedo-acc-control-stg-260830-232009-3851`):

   ```sh
   for id in <auth database id> <control-plane database id>; do
     curl -sS -X PUT "https://api.cloudflare.com/client/v4/accounts/683a2c01a4d43b2fa998cde8ddedaf0e/d1/database/$id" \
       -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
       --data '{"read_replication":{"mode":"auto"}}'
   done
   bunx wrangler d1 info claxedo-acc-auth-stg-260830-232009-3851      # read_replication.mode auto
   bunx wrangler d1 info claxedo-acc-control-stg-260830-232009-3851   # read_replication.mode auto
   ```

   The token needs D1:Edit. The dashboard's database Settings does the same. Until both report `auto` the `control-plane` job refuses before it deploys either Worker or moves a route, with an error naming this call for each database still off (`requireReadReplication`, `scripts/deploy/d1-databases.ts`).
2. Keep `CLAXEDO_STAGING_WORKER_PLACEMENT_REGION=aws:us-east-1`: it now pins the writer.
3. Check the deploy token can list zones and list and delete the zone's Worker routes (Zone Read, Workers Routes Edit), the access `wrangler deploy` already uses to attach routes; the first deploy moves the routes with it.
4. Merge to `staging`. The `control-plane` job deploys the writer `claxedo-user-deployed-locked-staging`, moves the seven control-plane routes off it, and deploys `claxedo-user-deployed-locked-staging-edge` with the same secrets. No new secret, variable, DNS record or custom domain.

### Rollback

Delete the edge Worker, which takes its routes with it, then redeploy the control plane from the previous commit, whose writer config carries the routes again: `bunx wrangler delete --name claxedo-user-deployed-locked-staging-edge`, then dispatch the `control-plane` job on that commit. Between the two the public origin answers control-plane paths with the deploy-window 503. Replication can stay on: without the Sessions API every query goes to the primary.

## Staging measurement plan

1. Signed browser loop (`app.claxedo.dev`, console, signed in): fetch `/api/auth/get-session`, `/api/workspace?host=provisioner`, `/api/control/session-list?scope=projects` and `/api/claxedo/credentials` twenty times each, and record `responseStart - requestStart` and the `Server-Timing` of each from `performance.getEntriesByType("resource")` (`server-requests-2026-10-20/README.md` has the snippet). Expect `d1-served;desc="APAC-replica"`, `d1` near R × the replica round, and TTFB about 0.12 s plus that.
2. The same for a write (`PUT /api/claxedo/credentials` on a sandbox key, or Settings → Models' check): expect `forward;dur` about 0.23 s plus the writer's `total`, `d1-served;desc="ENAM-primary"`, and TTFB within the edge's invocation of before.
3. `probe.sh` from `worker-cold-starts-2026-10-19` against `https://app.claxedo.dev` for `/health`, the descriptor and signed-out `get-session` at its idle gaps: every answer should carry `cf-ray …-SIN` and no `cf-placement` (the edge has no placement); compare cold counts and medians with that note's tables.
4. Read-your-writes: add an account, then read the list in the same tab and in a second tab within a second; both must show it. Start a cloud workspace from one tab and watch another: the `provision` notice's re-read must show the machine ready without a reload.
5. `wrangler tail claxedo-user-deployed-locked-staging-edge` and the writer's tail: `[timing]` lines over 1 s name where the time went on each side.

## Downsides

- Another actor's write that rings no notice (a share revoked by its owner, a machine's last-seen time, a suspended account) reaches a reader's replica reads after replica lag; every write and every route in `PRIMARY_READS` still decides on the primary.
- Two concurrent writes from one browser whose answers arrive out of commit order leave the older bookmark in the cookie; a read right after could miss the newer write until the replica catches up.
- The desktop's first call each session and every client that echoes no bookmark read through the writer, as today.
- A cold edge isolate adds its start to a forwarded write, before the forward; the writer's own cold start is unchanged.
