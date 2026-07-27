# WP-AUTH: Hosted Auth Migration — Clerk → Better Auth (Architecture Decision)

- **Status**: ACCEPTED (decision to migrate is made; this doc decides HOW)
- **Date**: 2026-07-11
- **Owners**: WP-AUTH
- **Siblings**: the cloud subscription launch plan (Polar $9/seat billing — doc 014 lineage), self-host parity plan (embedded Better Auth already shipped as W1)
- **Business context**: pre-launch, zero production users, subscription product at $9/seat via Polar. There is no cheaper moment to change identity infrastructure than right now.

This is an ADR, not an edit map. It reasons through where the hosted Better Auth issuer should live, who owns org/tenancy truth, and what the frontend contract should be — with the failure modes that drive each choice.

---

## 1. Current architecture and honest appraisal

### 1.1 How auth works today

**Hosted path** (Cloudflare Worker control plane): the SolidJS app loads `@clerk/clerk-js/headless` and asks Clerk for a JWT minted from the `convex` JWT template (`packages/claxedo-app/src/shared/data/auth-client.ts`, `getAuthToken()`). That one token is verified **twice**:

1. At the Worker edge — `controlPlaneAuthContext()` in `packages/claxedo-server/src/control-plane/auth.ts` verifies signature/issuer via Clerk's JWKS (`verifyClerkBearer`), with a fallback to the first-party CLI access token verifier (`cli-session-token.ts`).
2. At Convex — the Worker's Convex executor forwards the *same* bearer (`client.setAuth(token)` in `control-plane/adapters/convex/convex-authority-executor.ts`), and Convex checks it against the provider declared in `convex/auth.config.ts` (Clerk issuer domain, `aud: "convex"`). `requireIdentity` in `convex/model.ts` then keys everything on `tokenIdentifier` and pins the issuer.

Org membership is **mirrored** into Convex: Clerk fires webhooks → Svix-verified handler at `convex/http.ts` (`/api/clerk/webhook`) → `applyClerkWebhook` in `convex/orgs.ts` upserts `users`/`orgs`/`org_memberships` rows keyed by `clerk_org_id`/`clerk_subject`, with `clerk_updated_at` last-writer-wins guards.

**Self-host path** (Node server): `packages/claxedo-server/src/embedded-auth.ts` runs Better Auth 1.6.23 in-process — email+password, the `bearer()` plugin, better-sqlite3, migrations run at construction. Its verifier calls `auth.api.getSession` in-process (no HTTP hop) and adapts into the same `BetterAuthVerifier → betterAuthAdapter` seam. Note the token shape difference: self-host bearers are **opaque session tokens** verified statefully; the hosted path requires **JWTs** verified statelessly. This asymmetry matters for Decision 1.

**CLI path**: `/api/auth/cli/exchange` mints first-party EdDSA JWTs (access + refresh) from a verified Clerk bearer (`cli-session-token.ts` — this already works and is issuer-agnostic). The device-code flow (`routes/hosted-device-auth.ts`) fails closed with `501 device_login_unconfigured` because Clerk offers no device grant we can broker.

### 1.2 What is GOOD — keep it

**The adapter seam is the whole reason this migration is cheap.** `control-plane/auth.ts` reduces every identity provider to one function: `(token, config) → { subject, tokenIdentifier, issuer, audience?, orgId? }`. `clerkAuthAdapter`, `betterAuthAdapter`, `customVerifierAuthAdapter`, and `localOnlyAuthAdapter` are all constructors of the same `ControlPlaneAuthAdapter` shape, and everything downstream of `controlPlaneAuthContext` consumes claims, not vendors. Convex likewise consumes `ctx.auth.getUserIdentity()` claims, not Clerk objects. The migration therefore does not touch authorization logic anywhere — it swaps the token mint and the verification config. This was the deliberate P-shared.2 investment paying off.

**Fail-closed boot.** `worker.ts` refuses to serve (503 with a coded error) when a required secret is missing, and `controlPlaneAuthConfig` distinguishes "local-only by choice" from "misconfigured" (503, never silent-open). The 501 on unconfigured device login is the same discipline. Any new issuer must preserve this: misconfiguration must never degrade to unauthenticated access.

**The CLI token layer is already first-party.** `cli-session-token.ts` mints and verifies its own JWTs; it only needs *some* verified upstream identity to bootstrap from. It survives the migration untouched, which means the exchange endpoint, refresh flow, and `tokenKind: "cli"` handling are not at risk.

### 1.3 What is BAD / costly — why we're leaving

**The webhook mirror is a distributed-systems liability we never chose to price.** `applyClerkWebhook` is an at-least-once, unordered, eventually-consistent replication protocol between Clerk's org database and Convex's. Concretely:

- *Delayed webhook*: a user accepts an org invite in Clerk's UI, their JWT immediately carries the new `org_id`, but `org_memberships` has no row yet. `resolveForMe` in `convex/orgs.ts` silently falls back to the personal org — the user "joined" but sees nothing shared. This is not hypothetical; it is the designed behavior of the fallback branch.
- *Lost webhook*: Svix retries for a bounded window; past it, the membership row simply never exists. There is no reconciliation job. The system has no way to even *detect* the divergence — the truth lives in a vendor database we can only observe through events we may have missed.
- *Removal race, inverted*: `organizationMembership.deleted` arriving late means a **revoked** user keeps a mirror row (and any long-lived CLI token minted while it existed keeps resolving). Delayed grants are annoying; delayed revocations are a security bug class.
- The `clerk_updated_at` guards handle reordering of updates for the *same* entity but cannot conjure missing events or order cross-entity ones (membership arriving before its user row → `if (!user) return` — event dropped on the floor, permanently).

For a per-seat product this is disqualifying on its own: **the thing you bill on (seats) would be a lossy replica of a database you don't own.**

**Economics point the wrong way for per-seat.** Clerk is ~$0.02/MAU past the free tier plus **$1 per monthly-active organization** past 100 orgs ([Clerk pricing](https://clerk.com/pricing), [breakdown](https://www.promptstoproduct.com/clerk-pricing-explained)). At $9/seat, a 3-seat org paying $27/mo hands Clerk $1 + MAU fees — a vendor tax of several percent of revenue that *scales with exactly the metric we monetize* (active orgs), before we've built any org features of our own. Better Auth is a library: marginal auth cost is our own compute + a Postgres row.

**Org UI is delegated to Clerk's dashboard and components.** Invites, member lists, role changes live in Clerk's hosted surfaces. A paid team product needs those flows in-app, wired to *our* seat count and *our* billing (see §4) — so we'd be rebuilding the org UI regardless of vendor, at which point Clerk's org layer is pure cost.

**Vendor lock surface is wide but shallow — today.** The lock-in currently touches: the `clerk-js` frontend SDK, the `convex` JWT template, `CLERK_*` env names, the Svix webhook, and `clerk_*` columns in Convex. All of it sits behind seams (adapter, one frontend file, one webhook module). Every month of feature work on top of Clerk orgs deepens it. Migrating pre-launch converts "shallow and wide" into "gone."

**Dual issuers is a permanent test-matrix tax.** Every auth-touching change today must be validated against Clerk-hosted *and* embedded-Better-Auth. Converging both paths on Better Auth (same library, different composition) collapses that to one mental model — the hosted issuer becomes "embedded auth with Postgres and more plugins," and self-host stops being the odd sibling.

---

## 2. Decision 1 — where does the hosted Better Auth issuer live?

### 2.0 The framing fact that changes the question

Naive framing: "the Worker must call the issuer to verify every request, so the issuer must be fast/close." That is the self-host model (`bearer()` + in-process `getSession`) and it does NOT port. The correct hosted design uses Better Auth's **JWT plugin**: the issuer mints short-lived JWTs and publishes JWKS at `/api/auth/jwks` ([Better Auth JWT plugin](https://better-auth.com/docs/plugins/jwt)); the Worker verifies **statelessly** via cached JWKS (exactly as it does Clerk tokens today — `verifyClerkBearer` already speaks generic JWKS through `createClerkTokenVerifier`, which is Clerk-flavored in name only); Convex verifies the same token via a `customJwt` provider, optionally with the JWKS inlined as a static data URI so token validation makes **zero** network calls ([Convex Custom JWT](https://docs.convex.dev/auth/advanced/custom-jwt), [Convex + Better Auth JWKS notes](https://labs.convex.dev/better-auth/experimental)).

So the issuer is on the hot path only for **login, session refresh, and org mutations** — not for API-request verification. That reframes every option: we are placing a low-QPS, state-owning service, not a per-request dependency. Availability still matters (issuer down = nobody can log in or refresh = soft lockout after token expiry), but a 5-minute issuer outage does not 503 in-flight API traffic holding valid tokens.

### 2.1 Option (a) — dedicated small Node service on Fly, Postgres

**How it works.** A thin Node service (Hono + `auth.handler`) built from the same Better Auth composition pattern as `embedded-auth.ts`, but: Postgres instead of better-sqlite3, and plugins `jwt()` (JWKS for Worker/Convex), `organization()` (Decision 2), `deviceAuthorization()` (device grant, [Better Auth device plugin](https://better-auth.com/docs/plugins/device-authorization)), `polar()` (billing, [Polar Better Auth plugin](https://better-auth.com/docs/plugins/polar)), plus `bearer()` for parity. Deployed on Fly next to the existing relay (already Fly-only per the control-plane plan), fronted at `auth.claxedo.com`. The Worker proxies or the app calls it directly; the Worker itself only holds the issuer URL + JWKS URL as config — identical in shape to how it holds Clerk's today.

**Why good.**
- *Node is Better Auth's first-class runtime.* better-sqlite3 swaps for `pg` and everything else in `embedded-auth.ts` — migrations-at-boot, secret handling, verifier adaptation — carries over. The hosted issuer and the self-host issuer become the same code with different composition roots, which is the parity endgame the self-host plan has been driving toward.
- *Import-graph discipline is preserved for free.* The Worker's guard (`worker.import-graph.test.ts` forbids `better-sqlite3`, `node:crypto`, `fs`, …) stays intact because Better Auth never enters the Worker graph — the Worker keeps doing what it already does: JWKS verification of a bearer minted elsewhere.
- *Failure blast radius is bounded and legible.* Issuer down → logins/refreshes fail, existing tokens keep working until expiry, Worker returns clean 401/503s on the auth routes only. This is strictly better than the status quo (Clerk down has the same effect, but with a vendor SLA we can't see into).
- *Server-side plugin ecosystem lands next to the issuer,* which is where it must run: Polar's plugin does customer-create-on-signup, checkout, and webhook ingestion *inside* the Better Auth server; the device-authorization plugin needs durable device-code state; both are Node-comfortable and Postgres-backed.
- *Boring ops.* Fly Postgres (or Neon) is a solved problem; no LiteFS needed — Postgres from day one avoids the SQLite-replication science project. One region is fine: login QPS at our scale is trivial, and verification doesn't touch it.

**Why bad / tradeoffs.**
- One more deployable with its own secrets, migrations, monitoring, and backup story. Real cost, but we already operate Fly services (relay), and the alternative costs are worse (see below).
- Cold starts / autosuspend: keep one machine always-on; login latency is user-visible. At Fly's smallest always-on instance this is dollars/month.
- Cross-cloud hop for login flows (browser → Fly) while API traffic goes browser → CF Worker. Cosmetically odd, practically irrelevant — login is rare and redirect-based anyway.

**Doors.** Opens: first-party device-code CLI auth (the 501 stub becomes a thin broker pointed at our own issuer — `HostedDeviceAuthRoutes` was *literally built* for this: `provider.codeUrl`/`tokenUrl` config, audience server-pinned); Polar plugin colocated; channels (Slack/Telegram identity linking needs server-side OAuth callbacks — a Node issuer hosts them naturally); future OIDC-provider plugin if we ever want "Sign in with Claxedo." Closes: nothing meaningful.

### 2.2 Option (b) — inside the CF Worker on D1/Hyperdrive

**How it works.** Better Auth composed inside `worker.ts`'s graph, D1 (or Postgres-via-Hyperdrive) as the database, `nodejs_compat` flag on.

**Why good.** Zero extra services; auth lives at the same edge URL as the control plane; no cross-cloud anything; Worker never cold-starts meaningfully.

**Why bad.**
- *It detonates the import-graph guard's reason for existing.* The guard exists so the Worker stays a thin, auditable verification-and-brokering layer. Better Auth is a large dependency with database adapters, crypto, and email flows; pulling it in makes the Worker the fattest module in the repo and turns every Better Auth upgrade into a Worker-bundle-compat investigation. The guard would need carve-outs (`node:crypto` is forbidden today) — i.e., we'd weaken the mechanical protection precisely when adding the riskiest dependency.
- *Workers is Better Auth's roughest runtime.* It requires `nodejs_compat`, has a history of runtime breakage (e.g., [`createRequire` failure on import, Dec 2025](https://github.com/better-auth/better-auth/issues/6665), [non-compat support declined](https://github.com/better-auth/better-auth/issues/1375)), and the CLI's migration tooling can't reach D1's runtime-bound handle — community glue like [better-auth-cloudflare](https://github.com/zpg6/better-auth-cloudflare) exists *because* the paved path doesn't. We'd be betting the front door of a paid product on the ecosystem's least-tested corner. (This is exactly the "no duct tape" failure mode: guessing that a library works somewhere its authors treat as best-effort.)
- *Kills self-host parity.* The self-host issuer is Node + SQLite; a D1/Workers composition shares config shape but not runtime behavior, doubling the auth test matrix we're trying to collapse.
- *Blast radius inverts.* Issuer bugs (a migration wedge, an OOM from a dependency) now take down the entire control plane, not just login.

**Doors.** Opens: nothing option (a) doesn't. Closes: the clean Worker discipline; cheap Better Auth upgrades; runtime parity with self-host.

### 2.3 Option (c) — the existing self-host Node server binary, deployed as the hosted auth service

**How it works.** Deploy `server.ts` (the full Node control plane) with `CLAXEDO_EMBEDDED_AUTH=1` to Fly, but route only `/api/auth/*` to it; the Worker keeps serving everything else.

**Why good.** Zero new code at first; maximum literal code reuse; embedded auth is already tested.

**Why bad.**
- *It ships a workspace supervisor, tunnel server, SQLite stores, and an embedded runtime to production in order to run a login form.* The attack and misconfiguration surface is the whole local server; one stray route exposure or env flag and the hosted deployment grows capabilities it must never have. The hosted/self-host split exists precisely because these binaries have different trust profiles.
- *Wrong database.* Embedded auth is better-sqlite3-on-disk; hosted needs Postgres. The moment we swap the DB and add jwt/organization/polar/device plugins, we've forked the composition anyway — so the "reuse" collapses to what option (a) reuses, minus the clean packaging.
- *Upgrade coupling*: every self-host server release becomes a hosted-auth release.

Honest read: (c) is (a) with extra steps and extra risk. The right reuse boundary is the Better Auth *composition module* (extract the options-building from `embedded-auth.ts` into a shared function parameterized by database + plugin set), not the server binary.

### 2.4 Option (d) — status quo: keep Clerk hosted, Better Auth self-host

**Why good.** Zero migration work now; Clerk's login UX is polished; we stay focused on launch features.

**Why bad.** Every liability in §1.3 compounds: the webhook mirror becomes the substrate for *billing* (seat counts derived from a lossy replica); the org UI we must build anyway gets built against Clerk's API and rebuilt later; the dual-issuer test matrix persists; and the migration cost curve is at its global minimum *today* (zero users → no session migration, no password-hash import, no dual-issuer transition window, no support burden). Deferring converts a cheap swap into an expensive live migration. The decision to migrate is already made; (d) is recorded only to document why.

### 2.5 Recommendation: **(a) — dedicated Node issuer on Fly with Postgres, built from a shared composition with `embedded-auth.ts`**

Reasoning chain: (1) JWT-plugin + JWKS verification means the Worker and Convex never call the issuer per-request, so the issuer's placement is an ops question, not a latency question. (2) Given that, the dominant criteria are runtime maturity (Node ≫ Workers for Better Auth), blast-radius isolation (login-only, not control-plane), preservation of the import-graph discipline, and convergence with self-host — all of which point at a dedicated Node service. (3) The plugins the business needs next (device-code for `claxedo login`, Polar for billing, organization for Decision 2) are all server-side plugins that live inside the issuer process, which retro-justifies making it a real service rather than a Worker appendage. (4) Postgres from day one; skip LiteFS/SQLite replication entirely — this is the one place in the system where "just use Postgres" is unambiguous. One always-on Fly machine; single region; measure before adding more.

Config surface: `control-plane/auth.ts` gets its Better Auth JWKS config generalized (the `CLERK_*` env names in `controlPlaneAuthConfig` become issuer-neutral with aliases kept during transition — same playbook as the env-var cleanup); `convex/auth.config.ts` switches to a `customJwt` provider with static JWKS; `requireIdentity`'s issuer pin flips to the new issuer.

---

## 3. Decision 2 — who owns org/tenancy truth?

### 3.1 Options

**(i) Better Auth `organization` plugin as source of truth, mirrored into Convex.** The plugin owns orgs/members/invitations/roles in the issuer's Postgres ([org plugin](https://better-auth.com/docs/plugins/organization)); Convex's `orgs`/`org_memberships` become a replica maintained by… something. If that something is webhooks/hooks firing at Convex, **we have rebuilt `applyClerkWebhook` with the serial numbers filed off** — same delayed-grant, lost-revocation, cross-entity-ordering failure modes, except now both databases are ours so the failure is even less excusable. The honest answer to "is it better than the Clerk mirror?" is: *only* if the sync is synchronous-and-transactional or continuously reconciled; a fire-and-forget mirror is the same problem relocated.

**(ii) Convex as source of truth; Better Auth for identity only.** Better Auth owns users/credentials/sessions; the org plugin is not used; `orgs`/`org_memberships` stay in Convex, and we build invite/role mutations in Convex (guarded by `requireIdentity`). No replication at all — the JWT carries only `sub`, and every authorization check reads membership from Convex directly (which `requireProjectRole`-style checks already do).
- *Why good*: zero sync protocol; revocation is instant (delete the Convex row, next request fails authorization regardless of what the token claims); the seat count and the access-control rows are the same rows; self-host parity is clean (self-host uses the same Convex-shaped authority port backed by SQLite — orgs live behind `WorkspaceAuthority` either way, per the open-control-plane design).
- *Why bad*: we forgo the org plugin's prebuilt invitation flows (email invites, pending-invite lifecycle) and must implement them as Convex mutations + an email send; the JWT can't carry a trustworthy `org_id` claim (mitigable: treat any `orgId` claim as a *hint* for default-org selection, never as authorization input — which is already the safe reading of `resolveForMe`).

**(iii) Dual-write.** Both databases authoritative-ish, writes go to both. Rejected without much ceremony: dual-write without a transaction spanning both stores is the worst consistency model on the menu — every partial failure manufactures divergence, and now *neither* side can be trusted, including the one billing reads.

### 3.2 Where does Polar seat billing attach?

Seat count must be authoritative exactly once. Polar's Better Auth plugin lives in the issuer and handles customer creation, checkout, and webhook ingestion ([Polar adapter docs](https://polar.sh/docs/integrate/sdk/adapters/better-auth)); mapping seats to org membership is explicitly left to "your own membership tables" ([community pattern](https://dev.to/phumudzosly/polarsh-betterauth-for-organizations-1j1b)). So the billing question reduces to: which table is *the* membership table? Under (ii) it's Convex's `org_memberships` — the issuer's Polar webhook handler (or a small billing module beside it) calls a service-authenticated Convex mutation (the `*ForService` unsigned-executor pattern already exists in `convex-authority-sessions.ts`) to read seat counts and record entitlements. Enforcement ("can this org add a 4th member on a 3-seat plan?") happens in the same Convex mutation that inserts the membership row — check and write in one transaction, no cross-store race.

### 3.3 Recommendation: **(ii) Convex owns org/tenancy truth; Better Auth owns identity (users, credentials, sessions, tokens) only.**

The deepest lesson of §1.3 is *don't replicate authorization state across a trust boundary without a reconciliation story*. Option (ii) is the only one that deletes the replication instead of re-homing it. The price — hand-rolling invitations — is small and honest: it's a `org_invitations` table, two mutations, and an email; and §4 argues we must build the invite *UI* in-app anyway, so the plugin's prebuilt backend flows save less than they appear to. Migration path from today is also shortest: `orgs.ts` keeps its tables and drops the `applyClerkWebhook` mirror machinery; `clerk_org_id`/`clerk_subject` columns become vestigial (users get keyed by the new issuer's `tokenIdentifier`, which `convex/model.ts` already treats as the primary identity key — `token_identifier: "clerk:..."` rows simply never exist in the fresh hosted deployment; zero users means zero backfill).

One consequence to accept explicitly: the Better Auth `organization` plugin is NOT enabled on the hosted issuer, even though it's tempting. Enabling it "just for invites" recreates two membership tables and forces the sync question we just declined to answer.

---

## 4. Decision 3 — the frontend contract

### 4.1 Preserve `auth-client.ts`'s exported surface (swap internals) vs redesign

Today Clerk's entire frontend footprint is one file — `packages/claxedo-app/src/shared/data/auth-client.ts` — exporting `useAuth()` (session/user/loading signals, `signIn`/`signOut`/`signUp`, `getToken`), `getAuthToken()`, `initializeClerk()`, `clearPersistedAuthState()`, the account-switch purge guard, and the test-auth bypass. Everything else in the app consumes these exports.

**Recommendation: preserve the exported surface for the swap; rename/redesign later as a separate mechanical PR if ever.** Reasoning:

- The surface is already vendor-neutral in *meaning*: "reactive session, reactive user, get me a bearer, sign in/out." Better Auth's client maps onto it directly (`authClient.useSession`, `authClient.token()` from the JWT plugin, `signIn.email`/`signOut`). Redesigning the API and swapping the vendor in one motion couples a high-risk change (new issuer) to a zero-value churn change (new names), and makes bisecting regressions miserable.
- Several behaviors in this file are Claxedo inventions that must survive verbatim regardless of vendor and are easy to lose in a redesign: the `LAST_USER_ID_KEY` account-switch purge (cross-account localStorage bleed protection), `clearPersistedAuthState()`'s careful key preservation, and the `navigator.webdriver` / `opencode_test_auth` test bypass that the whole E2E harness depends on (Tier-M mocks route through it).
- Two internals *do* change semantically and deserve deliberate handling rather than surface preservation-by-accident: (1) `getToken({ template: "convex" })` — templates are a Clerk concept; the Better Auth JWT plugin issues one token shape, so the `template` option becomes a no-op accepted-and-ignored parameter during transition; (2) `signIn` stops being a redirect to a Clerk-hosted page and becomes an in-app route (Better Auth has no hosted pages — this is a *feature list item*, not a shim: we owe a login/signup screen, which self-host needs too and can share).

### 4.2 Why org-management UI is in-app regardless of vendor

Even if we had kept Clerk, a paid team product cannot ship invite/members/roles as links to a vendor dashboard: (a) seat enforcement must interpose on the invite/accept path ("you're at 3/3 seats — add a seat for $9?" is a *billing* interaction, and Clerk's UI knows nothing about our Polar state); (b) role semantics are ours (`clerkRole()` today lossily squashes Clerk roles into admin/member — the mapping direction is backwards; roles should be defined by our authorization model and stored where it's enforced); (c) the same screens must work on self-host, which has no vendor dashboard at all. So the org UI was always on our roadmap; the migration merely stops us pretending otherwise. Under Decision 2(ii) these screens talk to Convex mutations directly — the natural home they'd have needed anyway.

---

## 5. Risks, failure modes, and deliberate non-goals

**No SSO/SAML at launch — deliberate.** The buyer at $9/seat is a team on email+password/OAuth-social; SAML buyers demand SCIM, audit logs, and enterprise pricing to match, none of which exist yet. Better Auth has SSO/OIDC plugins when needed, and Decision 1(a) keeps that door open (server-side plugin, lands in the issuer). Trigger to revisit: first real prospect blocked on SSO, or an enterprise tier on the pricing page — whichever comes first. Do not build it speculatively; SSO built without a demanding customer is SSO built wrong.

**Self-host path untouched — deliberate.** `embedded-auth.ts` works, is tested, and is the *proof* that the adapter seam holds. The only sanctioned change is extraction of a shared composition module so hosted and embedded stop drifting — a refactor with zero behavior change, gated by the existing embedded-auth tests. Anything more risks the one auth path that currently has live verification (claxedo-selfhost-test.fly.dev).

**Session migration N/A — and that's the argument for now.** Zero production users means: no password-hash export negotiation with Clerk, no dual-issuer verification window in `controlPlaneAuthContext`, no "your session expired, please re-login" comms, no webhook-mirror backfill correctness proof. Every one of those is a project in itself post-launch. The entire class of migration risk is bought out by calendar position; it expires the day the first paying user signs up.

**Failure modes to design for (not discover):**
- *Issuer outage*: valid JWTs keep working (Worker + Convex verify via cached/static JWKS); logins and refreshes fail. Choose token TTL as the knob: too short → outage becomes lockout quickly; too long → revocation lag (a signed-out/removed user's JWT stays valid until expiry — mitigated because Decision 2(ii) makes *authorization* live in Convex rows, so a deleted membership bites on the next request even with a live token; only pure-identity revocation waits for expiry). Start at 15 minutes; document it.
- *JWKS rotation*: Convex static-JWKS (data URI) trades a network dependency for a deploy dependency — key rotation now requires a `convex/auth.config.ts` redeploy. Either accept rotation-is-a-deploy (fine at our scale, keys rotate rarely) or point Convex at the live JWKS URL and accept the fetch. Pick one and write it down; do not drift into both.
- *Fail-closed regression*: the new issuer config must flow through `controlPlaneAuthConfig`'s existing enabled/misconfigured/local-only trichotomy. A missing issuer URL must yield 503-misconfigured, never local-only. The existing tests around this are the guard; extend, don't bypass.

**The one unproven piece — spike FIRST:** the full token round-trip on real infrastructure: Better Auth (Node, Postgres, `jwt()` plugin) mints a JWT → CF Worker verifies it through the existing `customVerifierAuthAdapter`/JWKS path → the *same* token passes Convex `customJwt` with correct `aud`/`iss` → `requireIdentity` resolves a user. Everything else in this document is composition of parts we've already run; this chain — specifically claim-shape agreement (`aud`, `iss`, subject stability) between Better Auth's JWT output and Convex's `customJwt` expectations, where Clerk's `template: "convex"` currently does invisible work — is the only link no one has executed end-to-end. It is a half-day spike with a throwaway Fly app and a dev Convex deployment; if it fails, it fails cheap and early, and the fallback (Better Auth OIDC-provider plugin + Convex Custom OIDC) is known.

---

## Appendix: external sources

- Better Auth JWT plugin (JWKS at `/api/auth/jwks`): https://better-auth.com/docs/plugins/jwt
- Better Auth device authorization (RFC 8628): https://better-auth.com/docs/plugins/device-authorization
- Better Auth organization plugin: https://better-auth.com/docs/plugins/organization
- Polar Better Auth adapter: https://polar.sh/docs/integrate/sdk/adapters/better-auth and https://better-auth.com/docs/plugins/polar
- Polar + Better Auth org/seat mapping pattern: https://dev.to/phumudzosly/polarsh-betterauth-for-organizations-1j1b
- Convex Custom JWT provider (static JWKS data-URI option): https://docs.convex.dev/auth/advanced/custom-jwt and https://labs.convex.dev/better-auth/experimental
- Better Auth on Workers friction: https://github.com/better-auth/better-auth/issues/6665 , https://github.com/better-auth/better-auth/issues/1375 , https://github.com/zpg6/better-auth-cloudflare
- Clerk pricing ($0.02/MAU past free tier; $1/MAO past 100 orgs): https://clerk.com/pricing , https://www.promptstoproduct.com/clerk-pricing-explained

---

## ADDENDUM 2026-07-11 — Decision REVERSED at owner's direction: keep Clerk at launch

On owner review, this ADR's recommendation is **superseded**: Clerk stays for the hosted path at launch; the Better Auth migration is **deferred behind explicit triggers**, not cancelled. The options analysis above remains the reference for when a trigger fires.

**Why the reversal is correct (what the original weighing got wrong):**

1. **The cost argument was materially overstated.** Personal orgs are Convex-native (`convex/orgs.ts:personalOrgForUser` — `kind:"personal"`, no `clerk_org_id`), so Clerk's $1/MAO counts *team* orgs only, first 100 free. At the $5K/mo-profit target (~780 seats ≈ 80–150 team orgs, MAU well under the free tier), the realistic Clerk bill is **≈ $25/mo**. The MAO tax becomes real around ~1,000 active team orgs — roughly $45K+ MRR territory, where a migration funds itself.
2. **Opportunity cost dominates pre-launch.** The migration is 2–4 weeks of the scarcest resource on the critical path to revenue, replacing a working, battle-tested system. "Zero users = cheapest migration ever" is true and stays true in relative terms; but the *absolute* value of those weeks is highest right now (billing, tenant hardening, launch).
3. **Risk asymmetry.** Auth is the worst subsystem for a solo operator to own bugs in at launch (sessions, abuse, breached-password checks, email deliverability all come with Clerk). Better Auth is a fast-moving young library; owning its upgrade treadmill is a post-revenue luxury.
4. **The unification benefit was thinner than it looked.** Self-host keeps embedded Better Auth regardless, so two auth configurations exist either way; hosted-on-Better-Auth merely changes *which* two.

**What this un-blocks / changes elsewhere:** spike S1 (JWT chain) is cancelled; WP-AUTH drops out of the launch critical path; WP-BILLING (ADR 014) shifts to its pre-planned Option B (raw `@polar-sh/sdk`), Polar customer linked at first checkout via `external_customer_id` = Clerk user id — see 014 addendum. The Clerk webhook mirror (`applyClerkWebhook`) stays and stays load-bearing; treat its health as an ops concern (016's Sentry coverage should include Svix delivery failures).

**Migration triggers (any one re-opens this ADR, whose Decisions 1–3 then apply as written):**
- T-a: Clerk bill > 3% of MRR for two consecutive months, or > $500/mo.
- T-b: enterprise SSO/SAML demand where Clerk's per-connection pricing is the blocker rather than the enabler.
- T-c: a Clerk capability gap that blocks a shipped roadmap item (e.g. device-code flow proves unbuildable as a first-party broker on Clerk sessions — Better Auth has it as a plugin, RFC 8628, cited above).
- T-d: Clerk pricing/terms change adverse to the personal-orgs-stay-Convex-native pattern.

**What survives from this ADR regardless of vendor:** Decision 2's principle (Convex is the only org/tenancy truth; JWT org claims are hints, never authorization inputs) — already true under Clerk and must stay true; Decision 3's in-app org-management UI obligation (invites/members/roles cannot live in the Clerk dashboard for a paid product); the frontend `auth-client.ts` surface freeze (it is what makes the eventual migration one-file cheap).
