# Web app performance: what is done and what comes next (2026-10-21)

The signed-in web app from India was the target of the push that started on 18 October: every network-bound load, the boot, session open and reload, onboarding, provider setup, and the main thread. This note records where it ended, what is built but waiting, and the ranked list of what to do next, so the next push starts from measurements instead of rediscovery. Each finished lane has its own note in this directory; this one only links them.

## Where it stands

Rig numbers are `bun run --cwd packages/claxedo-app e2e:perf-web --reps=3 --profile=india-staging` (100 ms to static, 300 ms to the API, 10 Mbps), p50 of 3.

| Scenario | 18 Oct baseline | 21 Oct |
| --- | --- | --- |
| Signed-out login form | 3,940 ms | ~360 ms (a separate login document, 153 kB) |
| Cold `/` to the rail | n/a | ~790–840 ms |
| Cold session boot to text | 5,324 ms | ~1,660 ms |
| Warm reload to session text | ~830 ms | ~570 ms |
| Open a session from the rail | 704 ms | ~445 ms |
| Cold boot first paint | ~500 ms | ~180 ms (startup frame inlined in the shell) |
| Onboarding, four steps | 6,177 ms | ~4,900 ms |

Real staging, signed in from India (Jio, served from SIN), after the session cache: a warm signed read is 427–507 ms, of which the server is 34–68 ms; the rest is the round trip from India to the control plane pinned beside D1 in eastern North America. Before the push one read was 0.7–2.3 s and a cold boot downloaded 3.6 MB of uncompressed JavaScript.

What landed, by lane note: [one origin and request latency](./2026-10-18-web-one-origin.md), [signed-out document](./signed-out-document-2026-10-20/README.md), [reload and first paint](./reload-paint-2026-10-20/README.md), [onboarding steps](./onboarding-steps-2026-10-20/README.md), [server requests](./server-requests-2026-10-20/README.md), [session cache](./session-cache-2026-10-20/README.md), [main-thread JavaScript](./js-runtime-2026-10-20/README.md), [provisioning wait](./provisioning-wait-2026-10-21/README.md), [bundle and build](./bundle-build-2026-10-20/README.md), [Worker cold starts](./worker-cold-starts-2026-10-19/README.md).

## Built, waiting on the owner

**Edge Worker over D1 read replicas** — branch `perf/edge-replicas`. The control plane runs as two Workers from one bundle: an edge Worker that answers bookmarked reads from the nearest D1 replica, and the existing Worker, still pinned beside the primary, that every write and every primary-only read is forwarded to. One classifier decides which requests are forwarded, and a coverage test fails on any route it does not place. Expected from India: a warm signed read ~0.45 s → ~0.15–0.3 s, cold reads ~0.85 s → ~0.2–0.4 s, writes unchanged plus one hop. The deploy refuses the edge Worker until both staging databases report `read_replication.mode` `auto`; the owner enables it once per database (dashboard, D1 → database → Settings → Read replication, or a `PUT` of `{"read_replication":{"mode":"auto"}}` to the database with a D1:Edit token). Known trade-off: another person's write that rings no live-sync notice (a revoked share, a suspended account) reaches replica reads after replica lag; relay checks, turn admission and every write stay on the primary.

## Next, ranked by expected win

1. **One boot request instead of six.** A boot sends six signed reads in parallel; each verifies the session and each can land on a cold isolate, so the boot waits for the slowest (2.3 s on a staging reload with two cold isolates). One combined read is one round trip, one verification and one chance of a cold start. Expected: the largest remaining win for a cold boot and reload on staging.
2. **Worker cold start.** A cold control-plane request pays ~0.5 s over a warm one: ~170–300 ms of isolate start (parse and global scope of a 7.3 MB bundle; about half of the global scope is the OAuth provider plugin initialising) and ~150 ms of CPU composing the control plane on first use. In order: compose route groups on first use; defer the OAuth provider's setup to the routes that use it; drop the duplicate zod 3 copy; only then split rarely used modules (zip, plugin tooling, MCP SDK, the pricing table) behind dynamic imports the closure scanner can see. Expected: the cold penalty ~0.5 s → ~0.25–0.3 s.
3. **Relay revocation as a push.** The relay room asks the control plane whether a runtime access token is still active and where the workspace runs, each cached 10 s. Verifying the signed token in the room and having the control plane push revocations and target changes to the room (completing a revocation only after the room acknowledges it) removes that round trip from session opens and reloads that miss the cache. Approved in principle by the owner.
4. **Prefetch a session on pointer down** in the rail, not on click: ~150–300 ms off opening a session.
5. **Leftover serial D1 rounds** (from the server-requests lane): Better Auth's three-statement state consume as one `DELETE … RETURNING`; the session and sign-in evidence inserts as one batch; account writes that read every organization's sandbox leases before and after (owner `workspace/hosted-runtime-delivery.ts`); the hosted workspace create's unused `usersMe` round and its repeated membership read; the Connections list reading one credential per row; the sandbox key save scanning leases.
6. **Per-user Durable Object for hot reads**, if the replicas leave reads from India above ~150 ms: a per-user object placed in the user's region holding the session-to-user mapping and the rail catalog answers in one hop with in-process SQLite, for writes as well as reads; D1 keeps the global lookups. Start with a design note and a prototype of the boot read.
7. **Streaming main-thread cost**: the follow-scroll's forced layout and the live block's sanitize and DOM update are the largest per-delta costs left at 4× CPU (see the main-thread note).
8. **Code views after first text**: ~114 kB brotli, mostly `@pierre/diffs` with its own main-thread highlighter, prefetched after the first text whether or not a diff is opened.
9. **Sandbox readiness tails**: the Cloudflare sandbox Worker's own 500 ms health poll and 250 ms container poll are the largest lag left on that path (they reach people only when each organization redeploys its sandbox Worker); a Boat resume sent while a stop is still archiving may take back the same machine and skip a 13–27 s wait, which needs a live check.
10. **Edge routing from India**: the zone is on Cloudflare's Free plan; from Jio, Free sites are served from SIN, HKG, NRT or MRS while Business and Enterprise sites are served from Indian data centers at ~30 ms connect. Parked by the owner.

## Decided against, or parked

- **Warm snapshot in IndexedDB** (reload 829 → 189 ms in the rig): declined by the owner; do not re-propose.
- **Service worker for the shell and assets** (~100–140 ms off reloads): parked. If ever built, the self-unregistering kill switch with `Clear-Site-Data` comes first, the worker script is never cached, caches are versioned per deploy, and nothing but the build's own file list is stored.
- **Measured and not taken**: compile hints on the initial chunks, other minifiers than two-pass terser, lightningcss for CSS, `experimentalMinChunkSize`, lazy auth routes, a paint layer per Markdown block, keep-warm pings, sharing an in-flight composition (ledger rows in [AGENTS.md](./AGENTS.md)).

## Known issues found during the push

- **Changing the public origin orphans every user.** Application identities are keyed by the Better Auth issuer, which is derived from the public origin; moving staging from `api.claxedo.dev` to `app.claxedo.dev` left the owner's identity unmapped until a row for the new issuer was added. Any deployment whose domain changes would hit this; worth a design fix before launch.
- **A lost turn lease left the session busy forever** with the reply cut short; the common trigger (one unanswered renewal) is fixed, and the presentation of a genuinely lost lease is being fixed on `fix/lost-lease-turn`.
- **Test order differs between macOS and CI's Linux**, so order-dependent test bugs (a partial module mock, for one) surface only in CI.
- **Windows runners stall on disk** in the Tasks plugin's SQLite tests (one case in about sixty exceeded 5 s); the Tasks tests take the 30 s timeout the Documents tests already use.
- **e2e flakes under host load**: flow 24 "saved cloud history survives a replaced runtime" on web, flow 01 first-run reply under heavy load, and the phone baseline for `long-user-message` in flow 30, which is 106 px off on dev itself.

## Measuring

- Rig flags: `--coverage` (what each boot chunk and stylesheet actually runs), `--cpu=4`, `--stream=long-reply`, `--onboarding-only`, `--dist=<dir>` to alternate a control and a candidate build.
- Staging: the cold-start probe and stickiness scripts in [worker-cold-starts-2026-10-19](./worker-cold-starts-2026-10-19/README.md); the request trace in [server-requests-2026-10-20](./server-requests-2026-10-20/README.md); the session cache check in [session-cache-2026-10-20](./session-cache-2026-10-20/README.md). Server-Timing names `cold`, `compose`, `auth`, `d1`, `do`, `upstream`, `upstream-host` and `total`.
- Compare only simultaneous runs: a quiet staging lands about half its requests on cold isolates whatever the path, and an earlier baseline that looked better was warmed by session-host traffic.
