# Explicit Secrets Management UX

Status: PLANNED (not started)
Date: 2026-07-16
Doc id: 2026-07-16-004
Builds on: `2026-07-03-004-feat-connections-framework-plan.md`,
`2026-07-10-004-feat-connection-scoping-team-personal-plan.md`,
`2026-07-11-012-feat-cloud-subscription-launch-plan.md` (BYO-keys pricing model)

## Why

Claxedo's business model is BYO compute + BYO AI keys. That makes credential
onboarding the single most trust-sensitive flow in the product, and today it is
invisible: local credentials are harvested wholesale, stored, and fanned out to
workspaces without the user ever seeing what left their machine. This is bad UX
("sorcery"), a reputational landmine for an OSS fork whose launch strategy
depends on trust, and structurally impossible in a pure web product where there
is no local machine to harvest from.

The fix is NOT to remove the automation. It is to split **discovery** (stays
automatic, read-only) from **upload** (becomes explicit, itemized, scoped).
Target feel: `gh auth login` / 1Password — zero typing, nothing leaves the
machine without being enumerated on screen first.

## Owner decisions (settled — do not re-litigate)

- **D1 — Discovery is automatic, upload is explicit.** A discover step may read
  local credential files/keychain freely; persisting anything to the registry
  requires a user-visible, per-item, per-scope confirmation.
- **D2 — Clipboard-paste relay for web is REJECTED.** Clipboard managers log
  secrets, multi-line OAuth JSON pastes badly, and a pasted snapshot goes stale
  on refresh-token rotation. The web path is device-code direct push
  (`claxedo connect`), reusing the existing device-auth primitives. A plain
  paste field survives only as the last-resort path for simple API keys.
- **D3 — The UX object is a "Connection", not a raw secret.** "Anthropic —
  Claude subscription (OAuth)", "OpenAI — Codex subscription", "Anthropic — API
  key" are distinct connection types with distinct acquisition flows. The
  codex-provider-for-pi/opencode path is one such type, not a special case.
- **D4 — Scope is chosen at save time, shown in UI.** "This machine only"
  (local) vs "My cloud workspaces" (shared/fanout). This composes with, and does
  not replace, the team/personal partition from the connection-scoping plan.
- **D5 — No silent harvest anywhere.** Any code path that persists local
  credentials without a preceding explicit selection is a regression, same
  class as `/share` reappearing.
- **D6 — ToS exposure is named in the consent copy.** Reusing a Claude/Codex
  subscription token from cloud sandboxes is provider-ToS gray area. Consent
  copy must state where the credential will run. Explicit consent makes it the
  user's informed choice rather than something Claxedo did to them.

## Current state (verified 2026-07-16)

What already exists and is kept:

- **Collection**: `packages/claxedo-server/src/credentials/sync.ts` —
  `collectLocalCredentials()` reads opencode `auth.json`, `~/.codex/auth.json`
  + `~/.codex/accounts/*`, Claude Code creds (env → macOS keychain →
  `~/.claude/.credentials.json`), sandbox driver env vars, ACP env keys.
  `syncLocalCredentials()` persists everything found. Exposed as
  `POST /api/claxedo/credentials/sync-local` (accepts `provider_ids` filter) in
  `routes/credential.ts`. **Gap: no read-only preview; save is not itemized.**
- **Storage**: already sound — `SecretBackend` seam (`credentials/store.ts`),
  mandatory envelope encryption for hosted KV (`credentials/envelope.ts`,
  fails closed without KEK), AES-256-GCM local file store, SQLite
  `claxedo_provider_credential` holds metadata + opaque `secure_ref` only.
  Convex holds zero provider secrets. No storage work needed in this plan.
- **Fanout**: `registry.ts` `fanoutEligible()` allowlist +
  `resolveSecretsForScope("shared")` fans only `source: managed` creds to cloud
  workspaces via `workspace-supervisor-config-sync.ts` →
  `POST <runtime>/api/wr/config`. **Gap: scope is derived from `source`, never
  user-chosen, never shown.**
- **CLI**: `packages/cli/src/commands/creds.ts` (`claxedo creds sync --remote`)
  already prompts consent and PUTs a Codex bundle to a remote. Device-code
  login exists: `packages/cli/src/auth/device-code.ts` +
  `packages/claxedo-server/src/routes/hosted-device-auth.ts` (fails closed with
  `501 device_login_unconfigured` until an issuer is configured). **Gap: no
  `claxedo connect` verb; creds.ts covers Codex only; no push-to-my-account
  after device login.**
- **UI**: `features/settings/ui/providers.tsx` (list),
  `app/dialogs/connect-provider.tsx` (API key/OAuth connect, codex bundle for
  pi), `features/settings/ui/connections.tsx` (integrations w/ team-personal
  scope), `workbench/controls/usage-limits-popover.tsx` (tokentracker probe).
  **Gap: no discovery/consent surface, no onboarding step, no health/scope
  columns, no revoke-with-consequences.**
- **Usage probe**: `server-usage-limits.ts` (tokentracker-cli, exact-pinned,
  library-only) can tell us which subscriptions exist locally and their state —
  reusable as a discovery signal.

## Product contract

### Surfaces

1. **Connections page** (evolves `SettingsProviders`): one row per connection —
   provider, type (subscription OAuth / API key), scope badge (this machine /
   cloud workspaces; later team/personal), health (active / expires-soon /
   expired / revoked), last used, actions (reconnect, change scope, remove).
   Removing shows consequences ("3 cloud workspaces will lose Claude access").
2. **Discover dialog** (desktop/local server only): button "Detect on this
   machine" → renders the *preview* (provider, kind, masked account id, source
   path e.g. "macOS Keychain", freshness) with per-item checkboxes and a scope
   selector → single "Save selected" performs the itemized save. Copy states
   exactly where each credential will be usable (D6).
3. **Onboarding step "Connect your AI"**: first-run (no eligible credential in
   registry) surfaces provider cards. Desktop: card CTA = Discover dialog.
   Web/hosted: card CTA = OAuth-in-browser where the vendor supports it, else
   the `claxedo connect` device-code instructions, else API-key paste field.
   Skippable; never blocks entry to the app.
4. **CLI**: `claxedo connect [provider]` — device-code login to the hosted
   control plane (existing `login()`), then local discovery (same collector),
   itemized terminal consent (reuse creds.ts consent pattern), direct
   authenticated PUT to the user's account. Secret never transits browser or
   clipboard. `claxedo creds sync` becomes an alias/subset.

### API contract (claxedo-server)

- `POST /api/claxedo/credentials/discover` — runs `collectLocalCredentials()`
  but **persists nothing**; returns redacted preview items
  `{ provider_id, kind, label, account_id?, origin, fresh_until? }` plus a
  short-lived opaque `discovery_id` so the follow-up save cannot be replayed
  with different content than what the user saw.
- `POST /api/claxedo/credentials/save-discovered` —
  `{ discovery_id, items: [{ provider_id, scope }] }`; persists only the
  selected items with the selected scope and provenance
  (`consent: { at, surface }`) recorded in metadata.
- `PATCH /api/claxedo/credentials/:id/scope` — change local ↔ shared.
- `GET /api/claxedo/credentials` gains `scope`, `health`, `last_used_at` in the
  redacted listing.
- `POST /sync-local` is **removed** after all callers migrate (strangler:
  additive first, delete when consumers are gone). Loopback/worker adapters
  keep returning empty results as today.

### Data model deltas (SQLite `claxedo_provider_credential`)

- `scope TEXT` (`local` | `shared`) — replaces the implicit
  source-implies-scope rule; `resolveSecretsForScope("shared")` filters on the
  column, with a one-time backfill migration mapping today's
  `source: managed` → `shared` (preserves current behavior, no surprise
  revocations).
- `consent_json TEXT` (when/where/how the user approved; null for pre-existing
  rows = "migrated, unreviewed" and surfaced as such in UI).
- `last_used_at INTEGER` — stamped in `resolveSecret()`.

Make illegal states unrepresentable: a new row cannot be created `shared`
without a consent record; the registry constructor for discovered saves takes
`{ scope, consent }` as required fields, not options.

### Lifecycle

- Health derives from `status` + `expires_at` + provider probe
  (tokentracker snapshot where available). Expired → row shows "Reconnect",
  which routes to the same acquisition flow that created it.
- Central runtime already persists refreshed Codex tokens back to the registry
  (`central-session-runtime.ts`); extend the same write-back so a reconnect on
  one surface heals all consumers.

## Phases

Every phase is additive until its consumers are migrated; delete old paths only
when the new typed path has all consumers (goal.md operating rules). Tests
first for core modules: red → green → refactor.

### A - Phase 1: Discovery/consent API + scope column (server)

- [ ] `credentials/sync.ts`: split `collectLocalCredentials()` into pure
      discovery (returns preview items + secret material held in an in-memory
      `discovery_id` stash with TTL ≤ 5 min) and `saveDiscovered(items)`.
      Tests written first: discovery persists nothing; save persists exactly
      the selected subset; stale/unknown `discovery_id` fails closed; a
      discovery containing zero items returns an explicit empty preview.
      Progress:
- [ ] `discover` / `save-discovered` / `PATCH :id/scope` routes in
      `routes/credential.ts` with zod schemas; listing gains
      `scope`/`health`/`last_used_at`. Route tests cover redaction (no secret
      material in any response body, asserted by snapshot).
      Progress:
- [ ] Migration: add `scope`, `consent_json`, `last_used_at` columns; backfill
      `managed → shared`; `resolveSecretsForScope` filters on `scope` and a
      behavior test proves fanout output is byte-identical pre/post migration
      for existing rows.
      Progress:
- [ ] `sync-local` marked deprecated (still functional) with a server log
      warning naming this plan.
      Progress:

Acceptance: server test suite green on targeted files (full local vitest run
hangs — run targeted lists per `reference_claxedo_server_test_runner`); no
route returns secret material; discovery leaves the registry untouched.

### B - Phase 2: Desktop Discover dialog + Connections page

- [ ] Discover dialog component: preview list w/ per-item checkbox, masked
      account, origin ("macOS Keychain", `~/.codex/auth.json`), scope selector,
      D6 consent copy. Only rendered when the server is local/embedded
      (capability-probed, not platform-sniffed).
      Progress:
- [ ] `SettingsProviders` → Connections page: scope badge, health, last used,
      reconnect, change-scope, remove-with-consequences. Reuses
      `claxedoCredentialRequest`; no second data mirror — one reactive query
      graph per goal.md.
      Progress:
- [ ] State-machine tests for the dialog flow (closed → discovering → preview →
      saving → saved/partial-failure) and for health derivation. Kept-mounted
      dialog uses two-arg `createResource` gate
      (`reference_solid_createresource_gate`).
      Progress:
- [ ] Browser-use pass: drive discover → uncheck one item → save → verify the
      unchecked provider is absent from `GET /credentials`; vision-reviewed
      screenshots recorded (no-false-positive-verification rule: green tests
      are claims, screenshots are evidence).
      Progress:

Acceptance: a user can see exactly what was found, exclude items, choose scope,
and the registry reflects only the approved set.

### C - Phase 3: `claxedo connect` (web/cloud path)

- [ ] New CLI verb `connect [provider]` in `packages/cli`: `login()`
      (device-code, existing) → local discovery via the Phase-1 collector
      (imported, not reimplemented) → itemized terminal consent → authenticated
      `PUT /api/claxedo/credentials` per approved item with `scope: shared`.
      `creds sync` delegates to the same core.
      Progress:
- [ ] Hosted server: PUT path accepts the CLI session token identity and
      records consent provenance `surface: "cli"`. Fails closed when device
      login is unconfigured (existing 501 behavior preserved, with actionable
      copy).
      Progress:
- [ ] Web onboarding card renders the copy-able `npx claxedo connect claude`
      command with live polling: card flips to "Connected ✓" when the
      credential lands (reuse existing listing poll; no new socket).
      Progress:
- [ ] E2E: scripted run against a local hosted-mode server proving the secret
      never appears in browser network traffic (assert via har/network dump).
      Progress:

Acceptance: from a fresh browser session with no local server, a user gets a
working shared Claude/Codex credential without any secret transiting browser
or clipboard.

### D - Phase 4: Onboarding step + subscription-as-provider

- [ ] "Connect your AI" first-run step (no eligible credential ⇒ show; always
      skippable; re-reachable from Connections page). Desktop and web variants
      per the product contract.
      Progress:
- [ ] Codex-subscription-as-provider for pi/opencode surfaced as a first-class
      card (acquisition = existing codex bundle path in
      `connect-provider.tsx`), so "use your Codex subscription" is a visible
      choice, not tribal knowledge.
      Progress:
- [ ] Kill switch: remove `sync-local` route + any residual implicit-persist
      path; grep-gate in CI or debt-ratchet pin asserting no caller of
      `syncLocalCredentials` outside `save-discovered`.
      Progress:
- [ ] Final browser-use-driven video of both onboarding paths (desktop
      discover; web device-code) — watch the video, record path + what was
      verified, per goal.md verification loop.
      Progress:

Acceptance: onboarding demonstrably replaces every implicit collection path;
D5 holds by construction.

## Definition of Done (overall)

- [ ] No code path persists a local credential without an itemized, scoped,
      recorded consent (D1/D5) — enforced by construction (required
      `{scope, consent}` params) and by a ratchet/grep gate.
- [ ] Web product path works end-to-end with zero local Claxedo server and no
      secret in browser traffic or clipboard (D2).
- [ ] Connections page shows scope + health + last-used for every credential;
      expired credentials offer a working reconnect.
- [ ] Consent copy names cloud execution for subscription tokens (D6).
- [ ] Fanout behavior for pre-existing users is unchanged by the migration
      (backfill test).
- [ ] All new core modules have tests written before implementation;
      dialog/CLI flows have state-machine transition tests.
- [ ] Vision-reviewed screenshots/video exist for Phase 2 and Phase 4 flows;
      paths recorded in this doc's Progress slots.

## Unknowns register

- Q1: Does Anthropic offer a browser OAuth flow usable for subscription tokens
  in a third-party web app, or is CLI-collect the only web path for Claude?
  (Determines whether the web Claude card gets OAuth or device-code copy.)
- Q2: `discovery_id` stash location in hosted/Worker mode — in-memory is fine
  for the embedded server; Worker isolates may need KV-with-TTL. Decide in
  Phase 1 design spike.
- Q3: Linux Claude Code creds: `sync.ts` reads `~/.claude/.credentials.json`
  as fallback — verify against current Claude Code on Linux before claiming
  Linux support in onboarding copy (old gap chip existed).
- Q4: How team/personal (connection-scoping plan 3a/3b) composes with
  local/shared in UI copy without a 2×2 matrix confusing users — likely
  present as a single "Available to" selector.
- Q5: Whether `PATCH :id/scope` local→shared needs re-consent (leaning yes —
  it changes where the secret runs, D6).

## Edge cases

- Discovery finds a credential already in the registry → preview marks it
  "already connected", checkbox disabled (idempotent).
- Two Codex accounts under `~/.codex/accounts/` → preview shows both with
  account ids; user picks (today's code silently picks most-recently-refreshed).
- Credential expires between discover and save → save validates freshness and
  returns per-item failure, dialog shows partial result.
- User revokes a shared credential with active cloud sessions → consequences
  listed; runtime config push removes it on next sync (verify the removal
  actually propagates — add test).
- `claxedo connect` on a machine with nothing to discover → clear empty state
  pointing at API-key entry, not a silent success.

## Execution: parallelize with agents & workflows

Per goal.md operating rules (use parallel agents as much as practical;
disjoint file ownership; parallel tool calls for independent reads/tests):

- **Phase 1** parallelizes 3 ways with disjoint ownership: (a) collector split
  in `credentials/sync.ts` + tests, (b) routes + zod schemas + route tests,
  (c) SQL migration + backfill + fanout-parity test. Integrate behind one
  agent after all three are green.
- **Phase 2 and Phase 3 are independent** after Phase 1 lands — run them as
  parallel agents/worktrees (app UI vs CLI never touch the same files).
- Use a **Workflow** for the verification fan-out at each phase gate:
  targeted server test lists, `tsgo -b` typecheck, app unit tests
  (`--conditions=browser`), and browser-use flow drive as parallel stages;
  adversarially verify Phase-1 redaction claims (a skeptic agent tries to get
  secret material out of every new route).
- Research spikes (Q1 Anthropic OAuth, Q2 Worker stash) run as background
  research agents during Phase 1 implementation — they gate Phase 3/4 copy,
  not Phase 1 code.
