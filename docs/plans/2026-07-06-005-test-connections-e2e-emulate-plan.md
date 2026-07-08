# Plan: Local end-to-end test of the connections layer via vercel-labs/emulate + browser-use

- **Status**: RETAINED ACTIVE TEST PLAN (re-grounded 2026-07-09)
- **Date**: 2026-07-06
- **Owner doc for**: proving `@claxedo/connections` works end-to-end in the real product
  (real app UI → real claxedo-server → real stores → provider), with the provider
  side served by [vercel-labs/emulate](https://github.com/vercel-labs/emulate)
  instead of real GitHub/Google, and the UI driven by browser-use automation.
- **Current grounding**: `@claxedo/connections`, `connections-host`,
  settings connection UI, and the WorkGraph `forCapability` consumer still
  exist. Emulator endpoint override seams are not implemented yet, so P0-P2
  remain active prerequisites before the browser E2E.

## Why

Connections coverage today is three disjoint layers that never meet:

1. Kit unit tests (`packages/claxedo-connections/src/*.test.ts`) — routes, service,
   tokens, attempts, google/atlassian impls via injectable `fetch`.
2. Server composition tests (`packages/claxedo-server/src/connections-cors.test.ts`) —
   CORS + loopback/header gates on credential routes.
3. App flow tests (`settings-connections-core.test.ts`) — connect state machine, no server.

Nothing exercises UI → `/api/claxedo/integrations` → service → **real OAuth
round-trip through a browser** → credential store → consumer (`forCapability`).
The real-provider manual smoke needs Google Cloud console setup and real creds.
`emulate` closes the gap: stateful local emulators for GitHub and Google with
full OAuth flows (OIDC discovery, JWT tokens, consent pages), seedable, zero
network, `npx emulate --service github,google` (ports from 4000).

## Current-code facts (reverified 2026-07-09)

- `vendor/arctic/google.ts:7-9` hardcodes `accounts.google.com` /
  `oauth2.googleapis.com` endpoints. The injectable `fetchImpl` seam covers the
  **token/refresh/revoke** calls (server-side) but NOT `createAuthorizationURL` —
  that URL is handed to the **browser**, so emulation requires real endpoint
  injection, not a fetch wrapper.
- `impls/google.ts` threads `fetchImpl` but not endpoints. Kit principle (from
  `2026-07-03-004-feat-connections-framework-plan.md`): **the kit reads no env** —
  hosts supply everything as options. Endpoint overrides must be options, with the
  env read living in `connections-host.ts`.
- `impls/github.ts:20` — `verify()` hardcodes `https://api.github.com/user`;
  `fetchImpl` option exists but `connections-host.ts:43` calls `githubIntegration()`
  bare. Needs a `baseUrl` option + host wiring.
- `connections-host.ts` gates: all routes loopback-OR-signed; token/auth-failure
  routes loopback AND `x-claxedo-connections: 1` header. Unsigned local dev passes
  from loopback with zero auth setup — E2E from localhost needs no auth work.
- Google integration only registers when `CLAXEDO_INTEGRATION_GOOGLE_CLIENT_ID` +
  `_SECRET` are set; redirect URI is `${publicUrl}/api/claxedo/integrations/callback`
  (public URL defaults to `http://127.0.0.1:3001`).
- App: `settings-connections.tsx` calls `/api/claxedo/integrations` on the server;
  OAuth popup uses `window.open` (injectable in core, real in component).
- Workgraph consumer: `server-workgraph.ts:58` `githubAuthFromConnections` resolves
  a token via `connections.forCapability(capability, { integration: "github" })` —
  the observable is the resolved token handle, not a GitHub API call.
- **Do not regress**: the CORS fix (`isConnectionsCredentialPath` in `server.ts:130-165`,
  commit 02ef828225) — credential routes must never reflect `Access-Control-Allow-Origin`.

## Operating principles

- Read current source before implementing each slice.
- TDD for core modules: red → green → refactor.
- Keep every phase additive until consumers are migrated; no parallel/shadow implementations.
- Make illegal states unrepresentable (emulator overrides must be impossible to
  enable in signed/hosted mode — see P2).
- Per-slice verification loop; browser-use clears the visual gate; final
  browser-driven run recorded (video or screenshot sequence) with the evidence
  path written into this doc before marking done.

## Phases

### P0 — Emulator recon spike (no product code changes)

Pin and run emulate locally; verify its fidelity against exactly what our client
sends, BEFORE cutting any seams. Our Google client uses **PKCE S256 + HTTP Basic
client auth** on the token endpoint and expects refresh tokens when
`access_type=offline&prompt=consent` is set.

Tasks:
1. `npx emulate --service github,google` (pin the version in the harness script).
   Record actual ports + endpoint paths (authorization, token, consent page,
   GitHub `/user`).
2. Write a seed file (`packages/claxedo-server/e2e/emulate-seed.yaml`): a GitHub
   user (`login: octocat`) + accepted PAT; a Google OAuth app with our test
   client id/secret and redirect URI `http://127.0.0.1:3001/api/claxedo/integrations/callback`,
   short `expires_in` (e.g. 60s) so the refresh path is exercisable.
3. Script the full OAuth dance with curl/node (no product code): authorize URL →
   consent → code → token exchange with PKCE+Basic → refresh. This is the
   fidelity gate.

Acceptance:
- [ ] Section appended here recording emulate version,
      ports, endpoint paths, and any fidelity gaps (PKCE? Basic auth? refresh
      token issuance? consent-page selectors for automation). Progress:
- [ ] Standalone script completes code→token→refresh against the Google emulator
      and `GET /user` against the GitHub emulator with the seeded PAT. Progress:
- [ ] Go/no-go decision recorded. If emulate's Google flow can't do PKCE S256 or
      Basic auth, fallback is decided here (emulate GitHub-OAuth only, or
      contribute upstream, or in-repo fake provider) — do NOT bend our client to
      match the emulator. Progress:

### P1 — Endpoint seams in `@claxedo/connections` (TDD, kit stays env-free)

Tasks:
1. `vendor/arctic/google.ts`: optional `endpoints` constructor arg
   `{ authorization, token, revocation }` defaulting to the current constants.
   Note the adaptation in `LICENSE-NOTICE.md` (it documents all divergences).
2. `impls/google.ts`: optional `endpoints` option threaded to the `Google` client.
3. `impls/github.ts`: optional `apiBaseUrl` option (default `https://api.github.com`).
4. Unit tests first: authorization URL points at injected endpoint; token exchange
   hits injected endpoint (assert via injected fetch); github verify hits injected
   base.

Acceptance:
- [ ] All new options default to production values; zero behavior change with no
      options passed (existing tests green untouched). Progress:
- [ ] Kit reads no env anywhere (`grep -r "process.env" packages/claxedo-connections/src`
      → only vendor-free hits, ideally none). Progress:
- [ ] `cd packages/claxedo-connections && bun run typecheck && bun test src && bun run build` green. Progress:

### P2 — Host wiring in claxedo-server (guarded, dev-only)

Tasks:
1. `connections-host.ts` reads new env (names final at impl time):
   `CLAXEDO_INTEGRATION_GOOGLE_ENDPOINTS_BASE`, `CLAXEDO_INTEGRATION_GITHUB_API_BASE`.
   When set, thread as P1 options.
2. **Hard guard**: overrides are honored ONLY in unsigned-local mode (same
   predicate family as `isLoopbackLocalRequest` composition). In signed mode,
   presence of these vars is a startup error, not a silent ignore — illegal
   state unrepresentable.
3. Per env-var policy (`project_env_var_cleanup`): these are test-only vars with
   sensible defaults → NOT surfaced in user docs; document in the e2e runbook only.

Acceptance:
- [ ] With vars unset, `createConnectionsHost` output is byte-identical in
      behavior; `connections-cors.test.ts` and all gate tests green. Progress:
- [ ] Test: signed mode + override vars set → startup throws. Progress:
- [ ] Test: unsigned + vars set → google authorize URL targets the emulator base;
      github verify hits the emulator base. Progress:

### P3 — One-command harness

Tasks:
1. `packages/claxedo-server/e2e/connections-emulate.md` runbook + a launcher
   (script or `launch.json` entries) that starts, in order: emulate (pinned
   version, seeded, fixed ports) → claxedo-server :3001 with the override env +
   test Google client id/secret → app `bun run dev` :4444.
2. Healthcheck step: curl emulate's endpoints + server's `/api/claxedo/integrations`
   list route before declaring ready.

Acceptance:
- [ ] Single documented command brings up all three processes from a clean
      checkout; a second run is idempotent. Progress:
- [ ] Runbook includes teardown + how to reset emulator state between runs. Progress:

### P4 — Browser-driven E2E (browser-use / computer-use)

Drive the real UI at `http://localhost:4444` with the browser-use skill (or
claude-in-chrome computer use). Scenario script:

1. **GitHub key flow**: Settings → Connections → GitHub → paste seeded PAT →
   assert UI shows connected with `accountLabel: octocat` (proves `verify()`
   round-tripped through the emulator).
2. **Google OAuth flow**: Connect Google → `window.open` popup lands on the
   emulator consent page (localhost:400x) → approve → callback to
   `127.0.0.1:3001/api/claxedo/integrations/callback` → popup closes → UI shows
   connected.
3. **Credential routes**: from a loopback shell,
   `curl -H "x-claxedo-connections: 1" http://127.0.0.1:3001/api/claxedo/integrations/connections/<id>/token`
   returns the emulator-issued token; same call WITHOUT the header → 403
   `connections_header_required`; CORS preflight from a foreign origin gets no
   `Access-Control-Allow-Origin` (regression check on 02ef828225).
4. **Refresh path**: wait past the seeded 60s expiry (or seed shorter), re-hit
   the token route, assert a NEW access token (refresh executed against the
   emulator — the one path mocked-fetch unit tests can't vouch for).
5. **Failure path**: revoke/invalidate the connection in the emulator (or seed a
   rejecting token), trigger `auth-failure`, assert the UI surfaces the
   needs-reauth state.

Acceptance:
- [ ] All five steps pass in one recorded browser-use session; evidence path
      (video or screenshot sequence + curl transcript) recorded here. Progress:
- [ ] Watched/reviewed the recording and noted what it shows. Progress:

### P5 — Consumer verification (workgraph)

Tasks:
1. With the GitHub connection from P4 live, assert
   `githubAuthFromConnections` resolves it: either through the workgraph surface
   that consumes it, or a minimal integration test that boots `createApp` and
   calls `connections.forCapability("work-source"-family, { integration: "github" })`
   asserting the emulator token comes back.

Acceptance:
- [ ] Token resolved through `forCapability` against the real server + real
      store adapters (not the in-memory test store). Progress:

### P6 (stretch) — Codify as a repeatable scripted suite

Promote the P4 manual browser-use run into a scripted scenario (Playwright or
scripted browser-use) run by one command, using P3's harness. Not a release
gate for this plan; open a follow-up if deferred.

- [ ] Decision recorded: scripted now vs follow-up task filed. Progress:

## Definition of Done

- [ ] P0 fidelity gate passed with go decision (or documented fallback taken).
- [ ] Kit seams landed, env-free, all existing tests green, package builds.
- [ ] Host overrides landed with the signed-mode startup guard + tests.
- [ ] CORS/gate regression suite green (`connections-cors.test.ts` + new gate tests).
- [ ] One-command local harness documented and reproducible.
- [ ] Recorded browser-use E2E covering: key connect (GitHub), full OAuth connect
      (Google), token route + header gate, refresh-after-expiry, auth-failure —
      evidence paths written into this doc.
- [ ] Workgraph `forCapability` consumer verified against the live connection.
- [ ] No real provider credentials required anywhere in the loop.
- [ ] `bun run typecheck` green across touched packages; no new deps in
      `@claxedo/connections` (emulate is a dev harness dependency of the repo,
      never of the published kit).

## Execution: parallelize with agents & workflows

Fan out — these are disjoint by file ownership:

- **Agent A (recon)**: P0 entirely — external to our code; can start immediately.
- **Agent B (kit seams)**: P1 — owns `packages/claxedo-connections/src/**` only.
- **Agent C (harness)**: P3 scaffolding (runbook, launcher, seed file) — owns
  `packages/claxedo-server/e2e/**` only; blocked only on P0's port/path facts,
  can stub with placeholders meanwhile.

Barrier: P2 needs P1's option names (Agent B) and starts after; P4/P5 need
P0+P2+P3. Run P4's five checks as a single browser-use session, not parallel
(shared emulator state).

Adversarial verification (Workflow, post-P2): spawn independent reviewers to
attack the override guard — "can `CLAXEDO_INTEGRATION_GOOGLE_ENDPOINTS_BASE`
take effect in signed mode?", "does any change reintroduce ACAO reflection on
credential routes?", "can a non-loopback origin reach the token route?". These
are the two security-sensitive surfaces this plan touches; both have shipped
CVE-class bugs before (CORS reflection, fixed 02ef828225).

## Risks

- **Emulate fidelity** (top risk): PKCE S256 + Basic token auth + offline
  refresh-token issuance must all work or P0 kills/reroutes the plan cheaply.
- **Emulate is a vercel-labs experiment**: pin the version in the harness;
  treat upgrades as deliberate.
- **Consent-page automation**: emulator consent UI selectors are unknown until
  P0; browser-use handles arbitrary pages, so this is low.
- **Port collisions**: emulate defaults to 4000+, app dev server is 4444 —
  fix emulate ports explicitly in the launcher.
