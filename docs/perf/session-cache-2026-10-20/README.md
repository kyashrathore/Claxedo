# The browser principal cache, 20 October 2026

Every cookie-signed control-plane request verified the cookie against the databases before its own work, and on staging that verification was most of the request: `Server-Timing` `auth` 76–168 ms of a `total` 97–229 ms (`shared-sessions` auth 95, `session-list` auth 89, `remote-access/devices` auth 168, signed in from India, Worker in IAD, both D1 primaries in ENAM). A request whose session cookie was verified live in the last 60 s is now admitted on that verification's principal, carried by the browser in a signed cookie, and pays no verification round. The owner chose this on 2026-10-20 ("a short session cache so most requests skip the database session check"); the design, what it caches and the worst-case lag are in [the request authentication README](../../../packages/claxedo-server/src/platform/auth/README.md).

## What one signed request's `auth` did

Traced on the Worker's real composition (`better-auth-d1-compose.ts`), counted with `countD1Rounds` over both databases (`better-auth-d1-signed-rounds.d1.test.ts`):

1. Round 1, `AUTH_DB`: Better Auth's `getSession` (`disableCookieCache`, `disableRefresh`), the session row by token joined to its user. Decides: the cookie names a live, unexpired session, and whose.
2. Round 2, both databases at once: the sign-in evidence row bound to that session (how the person signed in, its assurance) and the control plane's identity row (`ensureApplicationIdentity`: the application user and human actor, and that both are active).

The route then runs, and its first round carries `requireHuman` (the identity is still linked, user and actor active) beside the route's own read. Everything that gates access, membership and role, workspace and session read authority, shares, is a statement of the route.

## What changed

- `withBrowserPrincipalCache` (`packages/claxedo-server/src/platform/auth/browser-principal-cache.ts`), composed around the Better Auth request adapter, answers a request that carries exactly one session cookie, no `Authorization` header and a trusted origin from `__Host-claxedo.principal` when that cookie's HMAC (an HKDF key from `BETTER_AUTH_SECRET`), deployment, auth configuration, expiry and session-cookie hash all hold. Otherwise the request is verified live, and its answer carries a fresh cache (`responseCookies`, appended by `authenticationResponseCookies` in the hosted core). An admitted request issues nothing, so 60 s after a live verification the next request is live again.
- Better Auth's answers that set or clear the session cookie (sign-in, sign-out, a refresh) expire the cache (`retireBrowserPrincipalCache`).
- Unchanged: the bearer transport (desktop, CLI), MCP tokens, the enrollment check `verifyIdentity`, Better Auth's own routes (`get-session`, OAuth authorize and consent, device approval), `requireHuman` and every authorization statement.

Why not the alternatives:

- Better Auth's `session.cookieCache` caches the session row only, so round 2 would stay, and every Better Auth route behind `sessionMiddleware` would read the cached session, the OAuth provider's authorize and consent among them (`getSessionFromCtx` without `disableCookieCache` in `@better-auth/oauth-provider` 1.7.1), letting a revoked browser session approve a desktop's 30-day refresh token for the cache's lifetime. `getSession` itself honours the cache only while the cached token equals the cookie's, the version matches and neither the cache nor the session has expired (`better-auth/dist/api/routes/session.mjs`), and sign-out's `deleteSessionCookie` expires it; those semantics are sound, the reach is not.
- A cache in isolate memory: the cold-start note measured that a client connection does not pin an isolate and that 17% of requests land cold after a 5 s pause and half after 30 s ([worker-cold-starts-2026-10-19](../worker-cold-starts-2026-10-19/README.md)); a cold isolate's memory is empty, and a warm one on another machine never saw the last request, so its hit rate is below that fraction exactly when a person pauses. The cookie reaches every isolate.

## Rounds per request, before → after

Serial D1 rounds across both databases, cookie-signed as the deployment's owner on the real composition (`better-auth-d1-signed-rounds.d1.test.ts`); "after" is a request carrying the cache, "live" is unchanged from before.

| route | before (live) | after (cached) | statements live → cached |
|---|---|---|---|
| `GET /api/workspace?host=provisioner` | 3 | 1 | 5 → 2 |
| `GET /api/workspace/shared-sessions` | 3 | 1 | 5 → 2 |
| `GET /api/claxedo/remote-access/devices` | 3 | 1 | 5 → 2 |
| `GET /api/control/session-list?scope=projects` | 4 | 2 | 7 → 4 |
| `GET /api/auth/get-session` | 1 | 1 | Better Auth's route, not cached |

The cached chain is `requireHuman ‖ the route's read`, then whatever the route reads after it; no statement of a cached request touches `session`, `authenticationEvidence` or the identity mapping (asserted in the test).

## What staging should show

Time model at the per-round costs the [signed-reads note](../d1-signed-reads-2026-10-18/README.md) measured (35–50 ms for a lone request, 77–107 ms four abreast): a cached request's `auth` reads about 0 (its HMAC and SHA-256 are CPU, and `performance.now()` on Workers advances only across I/O), so `total` drops by the 76–168 ms `auth` measured, to roughly the route's own `d1`.

Which requests hit:

- Within 60 s of any signed request in this browser (every interaction while a person works, and a reload while working): every cookie-signed read, including the boot's first wave (`shared-sessions`, `workspace`, `devices`, `connections`, `session-list`).
- A boot after more than 60 s of quiet: the first wave verifies live, five requests abreast as before, and each answer sets the cache; the second wave (`cp/events`, the workspace connection, `agent-config/harness`, the credentials reads on onboarding) is admitted.
- `get-session` is Better Auth's route and stays one round; relay requests carry Runtime Access Tokens and never touched this path.

To read it, paste [measure.js](./measure.js) into a signed-in staging tab: it fetches five signed reads in rounds a second apart and prints `auth`, `d1` and `total` per answer, with medians for the live ones (`auth` above 1 ms) and the cached ones. `await measureSessionCache({ gapMs: 61_000 })` afterwards shows every round going live. `trace.sh` of [server-requests-2026-10-20](../server-requests-2026-10-20/README.md) still prints any request over 1 s.

## The local rig

`bun run --cwd packages/claxedo-app e2e:perf-web --reps=3 --profile=india-staging` before (dev 7ad7d58d0b) and after (this change on that commit), same session window, shared host; the branch was then rebased onto dev 94f63ca666, where the round counts above were measured again and held:

| step (median of 3, ms) | before | after |
|---|---|---|
| cold-root/boot | rail 788 | rail 818 |
| first-session/press | session-text 475 | session-text 505 |
| cold-session/boot | session-text 1656 | session-text 1727 |
| warm-session/reload | session-text 562 | session-text 574 |
| open-session/press | session-text 444 | session-text 453 |
| open-session/type | key p50 5 | key p50 5 |
| switch-sessions/return-1 | session-text 25 | session-text 28 |
| switch-sessions/return-2 | session-text 20 | session-text 25 |
| switch-sessions/return-3 | session-text 22 | session-text 24 |
| switch-sessions/return-4 | session-text 20 | session-text 25 |
| lazy-pages/marketplace | marketplace 352 | marketplace 349 |
| lazy-pages/settings | settings 10 | settings 12 |
| signed-out-login/boot | login 358 | login 365 |
| onboarding/boot | onboarding:execution 982 | onboarding:execution 1001 |
| onboarding/next-to-project | onboarding:project 31 | onboarding:project 38 |
| onboarding/continue-to-ai | onboarding:ai 14 | onboarding:ai 15 |
| onboarding/create-to-draft | draft 4009 | draft 5578 |

The rig's API latency is the front's added 300 ms and Miniflare's D1 answers in well under a millisecond, so the two rounds the cache removes cost almost nothing here: no row should move, and none moved beyond what the host explains. The rig records no `Set-Cookie`, so the positive control is the probe below. The after run shared the host with another lane's `--cpu=4 --stream` rig (load 9–12 and 0.1–0.6 GiB free against 7–10 and 1.3–3.3 GiB before), and every row is a few percent slower alike. `create-to-draft` waits on the local sandbox reporting ready: every API answer on that step kept its 205–235 ms time to first byte and its 200, and the draft appeared one connection poll later (the fourth instead of the third, 5.3–5.7 s against 4.0 s); the sandbox starting later under that memory pressure is the inferred cause, since no request the step made changed. The win is the hop to D1, which only staging has.

## The probe: the browser holds the cache and spends it

`98-principal-cache-probe.spec.ts` signs the owner in on the signed e2e stack (the hosted Worker on Miniflare, the real app build), records every signed API answer's `Server-Timing` `auth` and whether it set the cache, then reloads. Copy it into `packages/claxedo-app/e2e/flows/` and run `CLAXEDO_E2E_PORT_RANGE=48500-48579 bun run e2e -- e2e/flows/98-principal-cache-probe.spec.ts --project=web --reporter=list`; it is not a flow of the suite. One run on this branch, before the rebase:

| answer | boot after sign-in | reload 2 s later |
|---|---|---|
| `workspace/shared-sessions` | `auth` 5 ms, sets the cache | 0, admitted |
| `workspace?host=provisioner` | 7, sets | 0, admitted |
| `remote-access/devices` | 8, sets | 0, admitted |
| `agent-config/connections` | 11, sets | 0, admitted |
| `control/session-list` | 13, sets | 0, admitted |
| `workspace/…/connection`, `agent-config/harness` (second wave) | 0, admitted | 0, admitted |

The browser held `__Host-claxedo.principal` HTTP-only, `Secure`, `SameSite=Lax`, expiring 57 s later. The boot's first wave left together before any answer, so all five verified live, as the time model above says a boot after a minute of quiet will; its second wave already spent the cache.

## What only staging can confirm

- `auth` on cached requests near 0 and `total` down by the measured `auth`, per route, with `measure.js`.
- The hit rate of real use: how often a request is the first after 60 s of quiet.
- That `Set-Cookie` on the API answers reaches the browser through the app Worker's `/api` proxy on the one origin (the session cookie already does).
