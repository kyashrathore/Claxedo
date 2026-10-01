# Workspace relay routing identity validation

Worktree: `opencode-app-v2-lanes/signed-web`; branch: `v2/signed-web`.
Baseline: `028ede31f3`. No push, rebase, stash, or other worktree changes.

## Contract

`applySandboxProvisionedTarget` owns the routing UUID together with the address.
Memory, SQLite and D1 stores use this transition. An unchanged ready target keeps
its identity; an address, host, resource or acquisition change gets a new UUID.
Release deletes the row, but does not reset a counter used for routing: the next
record gets another UUID. Lease epochs remain provisioning fences, not routing
identities. D1 also compares the observed routing UUID on address writes so a
concurrent same-epoch write cannot restore an earlier identity.

SQLite and D1 gain nullable `routing_id` columns. Acquiring rows have no route.
A cloud lease without a routing identity cannot be served; only recording a
canonical target creates one. There is no backfill, epoch translation, or legacy
token acceptance path.

All cloud token producers carry signed `routing_id`. Bun and Worker relays send
it as `routingId` to `/internal/relay/target`. The resolver compares it with the
current ready sandbox lease and returns `401 runtime_access_token_invalid` for
stale, missing, stopped or released cloud identities. The app's existing single
401 resend obtains its replacement through the connection POST, using
`startWorkspace`. Ordinary expiry refresh remains GET, so it cannot wake compute.
An upstream 502 does not renew or resend. A second 401 is returned to the caller.

## Bound and cost

The target cache is now only an in-flight coalescer keyed by workspace, host and
routing identity. It retains at most 8,192 pending lookups and no settled positive
or negative answers. A request after a lookup settles must consult current
authority, including an old token replayed after a new identity was served.

This is an admission fence, not atomic coordination between a database write and
an upstream network send. Requests already resolving/forwarding at a transition
can finish with their previous snapshot. An established stream is not closed by
an address change; its existing expiry/revocation policy still applies. The
runtime receives the relay-host token, not the original routing identity. There
is no runtime incarnation check claimed here. The cost is a control-plane lookup
for each request except concurrent identical lookups. The target TTL knob and
retained target cache were removed; revocation/host-generation TTLs remain for
their separate responsibilities.

## Red before production edits

From repository root:

```sh
bun test ./packages/sandbox-manager/src/manager.test.ts --test-name-pattern 'routing identity'
```

0 passed, 1 failed: `Expected: Any<String>; Received: undefined`. The real manager
resume kept its epoch, and the new routing identity was absent.

From `packages/claxedo-server`:

```sh
npx vitest run src/sandbox/stores/d1.test.ts src/authority/sandbox-relay-target.test.ts -t 'routing'
```

3 failed. Resume and release/re-acquire each returned `undefined` instead of a
routing identity. The resolver returned `{ found: true, baseUrl: "https://new.test" }`
for stale/missing identity instead of `{ found: false, code: "runtime_access_token_invalid" }`.

From `packages/workspace-relay`:

```sh
bun test src/main.test.ts --test-name-pattern 'routing fence'
```

0 passed, 1 failed: expected `baseUrl: "https://new.test"`, received
`baseUrl: "https://old.test"`. A fresh identity selected the old positive entry.

## Green focused verification

From `packages/claxedo-server`:

```sh
npx vitest run src/authority/sandbox-relay-target.test.ts src/sandbox/stores/sqlite-routing.test.ts src/sandbox/stores/d1.test.ts src/deployments/shared-routes/internal-relay.test.ts src/workspace/supervisor/cloud.test.ts src/workspace/routes/index.test.ts src/routes/hosted/workspace.test.ts src/authority/http/index.test.ts src/authority/hosted-session-pull.test.ts
```

337 passed. Additional final fixture checks:

```sh
npx vitest run src/deployments/self-hosted-node/internal-relay-node.test.ts src/workspace/runtime-dispatch/runtime-wait.test.ts
```

13 passed, including refusal to fall through to a host tunnel for an old cloud
identity. Total final focused server coverage: 350 passing tests. Covers all three findings; durable SQLite/D1 identity; repeated-address
stability; same-epoch D1 write races; missing/stopped/released identities; resolver
HTTP 401; supervisor behavior; cloud connection and internal token producers.

From `packages/workspace-relay`:

```sh
bun test src/main.test.ts src/worker.test.ts src/auth.test.ts
bun test src/server.test.ts --test-name-pattern 'stale routing'
```

Passed. Both resolver adapters transmit the identity and preserve the auth error.
The real relay HTTP entrypoint refuses old signed tokens before forwarding, both
before and after a fresh token is served. Coalescer tests prove distinct in-flight
identities, same-identity coalescing, the entry cap, and removal on completion.

From `packages/claxedo-server-core`:

```sh
npx vitest run src/workspace/http/workspace-runtime-client.test.ts src/platform/auth/runtime-access-token.test.ts src/adapters/relay/index.test.ts
```

44 passed. Signed claims and internal mint propagation verified.

## Package gates

- `packages/sandbox-manager`: `bun run build`, `bun run typecheck`, `bun run test` — passed; 291 tests.
- `packages/workspace-relay`: `bun run build`, `bun run typecheck`, `bun run test` — passed; 460 ordinary/bench/script tests, 125 Bun adapter tests, 13 workerd tests.
- `packages/claxedo-server`: `bun run typecheck` passed. Full `bun run test`: 3,346 passed, 23 failed, three skipped (312 files, 810 seconds). Seven failures were old-contract fixtures subsequently fixed and rechecked green: four workspace connection tests, one supervisor test, one internal proxy test, and one self-hosted resolver test. The other 16 failures are 14 document/file-watch/conflict cases (logs include `EMFILE`), the credential-scope sweep receiving `POST /api/claxedo/host/session-rows -> 501`, and the local route-family allowlist assertion. The full suite is not green; its script exits before the separate sandbox Worker sub-suite. No unrelated assertions were changed.
- `packages/claxedo-server-core`: `bun run typecheck` passed. `bun run test`: 1,193 passed, one file-watch timeout in `src/agent-config/index.test.ts`; the log reports `EMFILE: too many open files, watch`.
- `packages/claxedo-local-server`: `bun run typecheck` passed. An initial `bun run test` was interrupted when tests tried the real workspace-runtime data path. The isolated run below had 826 passes and eight failures: three launch-gate failures (`sysctl -n kern.boottime: Operation not permitted`), three plugin skill-count assertions, and two plugin file-watch failures (`EMFILE`).
- `packages/claxedo-app-v2`: `bun run typecheck`, `bun run test`, `bun run build`, `bun run check` — passed; 183 tests and all 19 checks. Build retains its existing large-chunk warning.
- Root: `bun run test:architecture-ratchets` — 13 tests and all eight product-boundary policies passed; helper verification failed with 4,235 findings and duplicate-copy count 166 → 4,148. No baseline/ceiling was raised. Listed findings include unchanged V1/V2 helper copies outside this fix.
- `git diff --check` — passed.

The additional local-server run used `bun run test --config .routing-vitest.config.ts`.
The temporary config spread its existing `vitest.config.ts` and added
`test.setupFiles: ["../claxedo-server/src/test-support/data-isolation.ts"]`;
it was removed afterward. Passing `--setupFiles` directly was rejected by Vitest's
CLI before tests ran. No runtime/process-ownership package suites were launched.

## Browser acceptance blocker

From `packages/claxedo-app-v2`:

```sh
CLAXEDO_E2E_PORT_RANGE=46900-46999 bunx playwright test e2e/flows/24*.spec.ts --workers=1
```

All six web/phone cases failed before browser launch. Chromium reports:

```text
FATAL:base/apple/mach_port_rendezvous_mac.cc:159
bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.<pid>:
Permission denied (1100)
```

No green browser run is claimed. The required three green repetitions remain
unverified. Follow-up: run this exact command three times outside the restrictive
execution sandbox, using the same dedicated port range. Live-provider behavior
also remains unverified; owner tests use real lease stores and a scripted driver.

Remaining broad-gate follow-up belongs to the repository owners and the runner
operator: restore permitted file watching and browser/launch-gate access, inspect
the unrelated route inventory and plugin assertions, rerun the failed suites,
then run flow 24 three times. These are not substituted with skipped tests or
raised architecture baselines.

Full raw command logs are in `/private/tmp/routing-evidence/` for this session.
