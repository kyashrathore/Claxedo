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

**Edge Worker over D1 read replicas** — merged to dev as an opt-in, `CLAXEDO_D1_EDGE_READS`, off everywhere including staging. Read replication is enabled on both staging databases, but the first staging deploy with it on stopped at its secrets check: the new edge Worker needs the writer's generated secrets (the runtime access token keys, the relay resolver token and others), which live only on the writer, and Cloudflare never returns a secret's value. The next step is to give the edge Worker only the secrets its read paths use, or have the deploy re-issue the generated secrets to both Workers at once; then turn it on for staging and measure. The control plane runs as two Workers from one bundle: an edge Worker that answers bookmarked reads from the nearest D1 replica, and the existing Worker, still pinned beside the primary, that every write and every primary-only read is forwarded to. One classifier decides which requests are forwarded, and a coverage test fails on any route it does not place. Expected from India: a warm signed read ~0.45 s → ~0.15–0.3 s, cold reads ~0.85 s → ~0.2–0.4 s, writes unchanged plus one hop. The deploy refuses the edge Worker until both staging databases report `read_replication.mode` `auto`; the owner enables it once per database (dashboard, D1 → database → Settings → Read replication, or a `PUT` of `{"read_replication":{"mode":"auto"}}` to the database with a D1:Edit token). Known trade-off: another person's write that rings no live-sync notice (a revoked share, a suspended account) reaches replica reads after replica lag; relay checks, turn admission and every write stay on the primary.

## Next, ranked by expected win

1. **One boot request instead of six.** A boot sends six signed reads in parallel; each verifies the session and each can land on a cold isolate, so the boot waits for the slowest (2.3 s on a staging reload with two cold isolates). One combined read is one round trip, one verification and one chance of a cold start. Expected: the largest remaining win for a cold boot and reload on staging.
2. **Worker cold start.** A cold control-plane request pays ~0.5 s over a warm one: ~170–300 ms of isolate start (parse and global scope of a 7.3 MB bundle; about half of the global scope is the OAuth provider plugin initialising) and ~150 ms of CPU composing the control plane on first use. In order: compose route groups on first use; defer the OAuth provider's setup to the routes that use it; drop the duplicate zod 3 copy; only then split rarely used modules (zip, plugin tooling, MCP SDK, the pricing table) behind dynamic imports the closure scanner can see. Expected: the cold penalty ~0.5 s → ~0.25–0.3 s.
3. **Relay revocation as a push.** The relay room asks the control plane whether a runtime access token is still active and where the workspace runs, each cached 10 s. Verifying the signed token in the room and having the control plane push revocations and target changes to the room (completing a revocation only after the room acknowledges it) removes that round trip from session opens and reloads that miss the cache. Approved in principle by the owner.
4. **Prefetch a session on pointer down** in the rail, not on click: ~150–300 ms off opening a session.
5. **Leftover serial D1 rounds** (from the server-requests lane): Better Auth's three-statement state consume as one `DELETE … RETURNING`; the session and sign-in evidence inserts as one batch; account writes that read every organization's sandbox leases before and after (owner `workspace/hosted-runtime-delivery.ts`); the hosted workspace create's unused `usersMe` round and its repeated membership read; the Connections list reading one credential per row; the sandbox key save scanning leases.
6. **Per-user Durable Object for hot reads**, if the replicas leave reads from India above ~150 ms: a per-user object placed in the user's region holding the session-to-user mapping and the rail catalog answers in one hop with in-process SQLite, for writes as well as reads; D1 keeps the global lookups. Start with a design note and a prototype of the boot read.
7. **Streaming main-thread cost**: the follow-scroll's forced layout and the live block's sanitize and DOM update are the largest per-delta costs left at 4× CPU (see the main-thread note).
8. **Code views after first text**: ~114 kB brotli, mostly `@pierre/diffs` with its own main-thread highlighter, prefetched after the first text whether or not a diff is opened. The boot-bytes lane measured it and kept the prefetch: without it, the first expanded diff would wait about 343 ms on the India profile ([boot-bytes-2026-10-21](./boot-bytes-2026-10-21/README.md)). Only a smaller viewer would move this.
9. **Sandbox readiness tails**: the Cloudflare sandbox Worker's own 500 ms health poll and 250 ms container poll are the largest lag left on that path (they reach people only when each organization redeploys its sandbox Worker); a Boat resume sent while a stop is still archiving may take back the same machine and skip a 13–27 s wait, which needs a live check.
10. **Edge routing from India**: the zone is on Cloudflare's Free plan; from Jio, Free sites are served from SIN, HKG, NRT or MRS while Business and Enterprise sites are served from Indian data centers at ~30 ms connect. Parked by the owner.
11. **The MCP App host's frame in the boot** (boot-bytes lane): `mcp-apps/view/frame.tsx` with its bridge, bootstrap and requests, about 20 kB raw, still loads with every signed boot. A lazy `McpAppFrame` whose chunk starts loading while the part's document is pending keeps the placeholder up until both land. Expected: about 6 kB brotli off the first wave. Owner `src/mcp-apps`.
12. **Plugin surface pages prefetched on intent** (boot-bytes lane): the surface renderer, zod and the Kobalte controls it uses (62 kB brotli in 15 files) now load after every signed boot settles. Prefetching them when the pointer reaches a surface page's rail row or tab would spare that download for people who never open Tasks. Owner `src/plugins`.
13. **A slot frame's stylesheet copy** (boot-bytes lane): a live plugin's rendered page, settings section or overlay still serializes every CSS rule on the page when its frame opens (about 14 ms unthrottled, about 40 ms at 4x CPU). Serving the frame its own stylesheet URL requires the frame's `style-src` to allow the app's origin. Owner `src/plugins/frame`.

## Decided against, or parked

- **Warm snapshot in IndexedDB** (reload 829 → 189 ms in the rig): declined by the owner; do not re-propose.
- **Service worker for the shell and assets** (~100–140 ms off reloads): parked. If ever built, the self-unregistering kill switch with `Clear-Site-Data` comes first, the worker script is never cached, caches are versioned per deploy, and nothing but the build's own file list is stored.
- **Measured and not taken**: compile hints on the initial chunks, other minifiers than two-pass terser, lightningcss for CSS, `experimentalMinChunkSize`, lazy auth routes, a paint layer per Markdown block, keep-warm pings, sharing an in-flight composition (ledger rows in [AGENTS.md](./AGENTS.md)).

## Known issues found during the push

- **Changing the public origin orphans every user.** Application identities are keyed by the Better Auth issuer, which is derived from the public origin; moving staging from `api.claxedo.dev` to `app.claxedo.dev` left the owner's identity unmapped until a row for the new issuer was added. Any deployment whose domain changes would hit this; worth a design fix before launch.
- **A lost turn lease left the session busy forever** with the reply cut short; the common trigger (one unanswered renewal) is fixed, and the presentation of a genuinely lost lease is being fixed on `fix/lost-lease-turn`.
- **Test order differs between macOS and CI's Linux.** A `mock.module` stand-in no longer reaches other files: the app and workspace-runtime suites run with `--isolate`, and a ratchet holds every package whose bun tests replace a module to it.
- **Windows runners stall on disk** in the Tasks plugin's SQLite tests (one case in about sixty exceeded 5 s); the Tasks tests take the 30 s timeout the Documents tests already use, and a change to Documents, Tasks or helpers now runs the Windows unit leg.
- **Flow 40 failed with Claude Code CLI 2.1.306**, which defers MCP tools behind `ToolSearch`. Fixed: the app e2e runs the pinned Claude Code and Codex the harness e2e runs, and flow 40 calls the guide tool instead of reading the first tool list.
- **A Windows CLI test timed out once** (`@claxedo/cli` `connect.test.ts`, "timed out waiting for first beat") and passed on the next run. Not reproduced in 84 Windows runs; the one slow step on that path is the first PowerShell start, which timed out a helpers test at 5.1 s, so both suites get the Windows 20 s budget and the wait 15 s there. The cause is inferred, not observed.
- **The launch gate's "payload environment without PATH" test failed about once in thirty Linux CI runs.** Fixed: `/proc/<pid>/stat` read while the parent reaps the process shows state X and group -1, which verification took for a different process; it now reads as an exit, which signals nothing.
- **e2e flakes under host load**: flow 24 "saved cloud history survives a replaced runtime" on web, flow 01 first-run reply under heavy load, and the phone baseline for `long-user-message` in flow 30, which is 106 px off on dev itself.

Regression guards for the failures above and the week's other Windows and Linux CI failures:

| Failure | Guard | Red before, green after | Runs on |
| --- | --- | --- | --- |
| A partial `mock.module` linked into later files on Linux file order | `script/bun-test-isolation.test.ts:30`; `--isolate` in the app and workspace-runtime test scripts | A planted `@/shell` stand-in fails the regions and data binding tests without `--isolate` and passes with it; the ratchet fails when the flag is removed | Every OS (ratchet: Linux CI, pre-push) |
| bun:sqlite statements not finalized on close, EBUSY on Windows | `packages/claxedo-server-core/src/platform/db/db.test.ts:285` (a Bun child that removes the data directory) | Fails on the earlier db.ts with `ranAfterClose: true` | Linux and Windows (`unit (windows, rest)` runs it) |
| `fs.rm` of a directory symlink, EFAULT under Bun on Windows | `packages/claxedo-documents/src/host/repository/index.test.ts:365` uses `fs.unlink`; no static check can tie a removal to a symlink made under another expression, so a Documents change now selects the Windows leg (`script/ci-changes.test.mjs:87`) | Selector test fails on the earlier selector | Windows |
| pid reuse counted as one agent | `packages/workspace-runtime/src/workspace/runtime-acp-idle-release.test.ts:38`, `runtime-acp-recovery.test.ts:93,151`, `runtime-startup-question.test.ts:102,124` (agents named by a UUID they mint) | With every agent reporting one pid, the earlier recovery test fails 5 of 6 and the new one passes | Linux and Windows |
| Launch-gate `retire` read a reaped leader as a different process | `packages/process-ownership/src/launch/identity.test.ts:163`, `retirement.test.ts:161` | Both fail on the earlier identity.ts with `identity_mismatch` / `leader: "unknown"` | Linux |
| Flow 40 broke on Claude Code 2.1.306 | `packages/claxedo-app/e2e/flows/40-app-plugin-tools.spec.ts:72`; the app e2e runs `pinnedAgentEnv()` | Earlier assertion fails on 2.1.306; the new one passes on 2.1.306 and the pinned 2.1.285 | macOS e2e |
| Tasks SQLite stall past 5 s on Windows | 30 s `--timeout` in Tasks and Documents; session-core 20 s, server-core 15 s on Windows; no on-disk SQLite suite keeps the 5 s default there | Not reproducible on demand | Windows |
| helpers' first private-file write past 5 s on Windows; CLI "first beat" timeout | `windows-test-timeout.mjs` in the helpers and CLI test scripts; `packages/cli/src/commands/connect.test.ts:34` waits 15 s on Windows | Helpers failure observed in run 39504671508; the CLI stall was not reproduced in 84 Windows runs | Windows |
| A cached typecheck replayed a pass after a dependency's export changed | `turbo.json:11` (`typecheck` depends on a `transit` task) | Widening helpers' `stringRecord` replayed process-ownership's pass before and fails it with TS2322 after | Every OS (local turbo cache) |
| A native compile in the CLI's install closure | `script/install-steps/verify.test.ts:30` | Fails when tree-sitter-bash loses its win32-x64 prebuild | Linux CI, pre-push |

## Measuring

- Rig flags: `--coverage` (what each boot chunk and stylesheet actually runs), `--cpu=4`, `--stream=long-reply`, `--onboarding-only`, `--dist=<dir>` to alternate a control and a candidate build.
- Staging: the cold-start probe and stickiness scripts in [worker-cold-starts-2026-10-19](./worker-cold-starts-2026-10-19/README.md); the request trace in [server-requests-2026-10-20](./server-requests-2026-10-20/README.md); the session cache check in [session-cache-2026-10-20](./session-cache-2026-10-20/README.md). Server-Timing names `cold`, `compose`, `auth`, `d1`, `do`, `upstream`, `upstream-host` and `total`.
- Compare only simultaneous runs: a quiet staging lands about half its requests on cold isolates whatever the path, and an earlier baseline that looked better was warmed by session-host traffic.
