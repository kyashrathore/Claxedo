# GOAL — Claxedo Cloud subscription launch (Polar + tenant hardening + ops floor; Clerk retained)

Date: 2026-07-11 (revised same day: Clerk retained at launch — see 013 addendum)
Status: **architecture decided (ADRs 013–016 + addenda); execution gated on spike S2**
Scope: hosted control plane billing + tenant hardening + ops. OUT: Better Auth migration (deferred w/ triggers, 013 addendum), relay multi-instance routing (deferred w/ triggers, 016 §6), usage metering (none needed — per-seat), pricing page/marketing.

Read in this order:
1. **013 — WP-AUTH** `2026-07-11-013-wp-auth-better-auth-migration-design.md` — Clerk vs Better Auth analysis; **ADDENDUM: Clerk stays at launch; migration deferred behind triggers T-a…T-d**
2. **014 — WP-BILLING** `2026-07-11-014-wp-billing-polar-subscription-design.md` — Polar architecture; **ADDENDUM: Option B (raw SDK) invoked**
3. **015 — WP-TENANT** `2026-07-11-015-wp-tenant-hardening-design.md` — multi-tenant isolation architecture
4. **016 — WP-OPS** `2026-07-11-016-wp-ops-floor-design.md` — deploy/observability/reconciliation architecture

Business decisions (fixed; owner memory `claxedo-cloud-pricing`): $9/mo · $89/yr per SEAT (annual = "2 months free"; decided 2026-07-12), flat for individuals (org of 1) and teams; BYO compute (user-hosted VM via relay) + BYO AI keys; Polar as Merchant of Record; free tier = self-host-equivalent; 14-day Polar-native trial. Fee-adjusted contribution ≈ $6.55/seat/mo; $5K/mo profit ≈ ~780 seats. Clerk cost at that scale ≈ $25/mo (personal orgs are Convex-native, never Clerk MAOs; first 100 MAOs free).

---

## §1 — Decision summary (each argued in full in its ADR)

| # | Decision | Choice | ADR |
|---|---|---|---|
| D1 | Hosted issuer | **Keep Clerk at launch.** Better Auth migration deferred behind triggers (bill >3% MRR or >$500/mo; SSO-pricing blockage; capability gap; adverse pricing change). 013's Decisions 1–3 apply as written when a trigger fires. | 013 addendum |
| D2 | Org/tenancy truth | **Convex only** (already true under Clerk; keep it true). JWT/org claims are hints, never authorization inputs. In-app org-management UI (invites/members/roles) is built now — owed for a paid product regardless of vendor. | 013 §3 + addendum |
| D3 | Frontend auth contract | `auth-client.ts` exported surface frozen — it is what keeps the eventual migration one-file cheap. | 013 §4 |
| D4 | Polar integration surface | **Raw `@polar-sh/sdk` + own webhook route (Option B).** Customer created lazily at first checkout, `external_customer_id` = Clerk user id. Webhook + checkout routes live in the CF Worker (SDK is fetch-based; Standard-Webhooks verify is WebCrypto-safe — S2 confirms under workerd); Polar code confined by directory, enforced in the import-graph guard. | 014 §2 + addendum |
| D5 | Subscription state | Mirror into Convex `orgs` fields; webhook (`customer.state_changed`, full-state + source-timestamp guard) is single writer via one `applyPolarState` module; **plus scheduled reconciliation sweep** (Polar disables endpoints after 10 failed deliveries). Unknown state fails closed to free = degradation, not lockout. | 014 §3 |
| D6 | Seats | Hard-block member add beyond `seats_licensed` with inline seat purchase; plain subscription `quantity` (Polar seat-assignment feature only as pre-decided fallback); Claxedo membership is the sole "who's on the team" truth. | 014 §4 |
| D7 | Connection partition | Org-scoped team partition via existing opaque `owner` key (`org:{orgId}` hosted; owner-absent = self-host team ⇒ zero self-host migration). **Sequencing: merge `codex/feat-connection-scoping` as-is; org-scoping is a follow-up.** Hard gate: hosted connections stay 503 until org partitioning live. | 015 §2 |
| D8 | Isolation enforcement | Mandatory `authedQuery`/`authedMutation`/`serviceMutation` Convex builders (converts ~15 `allowUnsigned` holes into verified machine principals) + architecture guard ratcheting raw builders to zero. Row-level tenant_id deferred with triggers. | 015 §3 |
| D9 | Deployment mode | Explicit `CLAXEDO_DEPLOYMENT_MODE=hosted` fail-closed boot (auth, authority, credential backend, org partitioning asserted); self-host default zero-config; ONE global auth middleware, per-route loopback guards demoted to defense-in-depth. | 015 §4 |
| D10 | Hosted credentials | CF KV as byte store + mandatory envelope-encryption wrapper above `SecretBackend` (per-org HKDF subkeys, key-id-prefixed ciphertext, KEK in Worker secret). **Finding: `credentials/cloudflare.ts` currently stores KV values in PLAINTEXT — AES-GCM is local-backend-only.** Stub stays fail-closed until wrapper + org partitioning exist. | 015 §5 |
| D11 | Deploys | GH Actions: auto staging on `dev` + behavioral smoke + one-click prod promotion. Order Convex→Worker→relay; DO migrations & schema changes ship solo. Rollback per-unit honest: wrangler rollback / Fly prior image / Convex roll-forward-only (additive schema discipline). Relay: drain-then-deploy + published windows; multi-instance deferred w/ triggers. | 016 §2–3 |
| D12 | Observability | Sentry on Worker + relay + Convex (Pro), release = git SHA. Exactly TWO page classes (payment-path errors; external uptime failure); all else daily digest — solo-operator design. **Include Svix/Clerk-webhook delivery failures in coverage (the org mirror stays load-bearing under D1).** | 016 §4 + 013 addendum |
| D13 | Reconciliation | Three layers, they fail differently: Daytona native auto-stop (control-plane-death-proof money backstop) + CF Cron driving two-way driver-vs-lease sweep (Sentry Crons-monitored) + event-driven release as fast path only. | 016 §5 |
| D14 | Convex evolution | Expand-migrate-contract as law; `@convex-dev/migrations` component as mechanism; hand-rolled backfills retired. | 016 §6 |

## §2 — Blocking spike

- **S2 (Polar mechanics, test mode):** mid-cycle quantity increase (prorated charge; behavior on charge FAILURE), decrease (credit vs refund), webhook events/latency for quantity changes, plain-quantity without the beta seats feature, `@polar-sh/sdk` webhook signature verification under workerd (miniflare), external-customer-id checkout linkage end-to-end, annual×seats×trial interactions. Pre-decided fallbacks in 014 §6 — no S2 answer reopens D4–D6. Evidence appended to 014.
- ~~S1 (Better Auth JWT chain)~~ — cancelled with D1; revives only if a migration trigger fires.

## §3 — Execution order

```
Wave 0  S2 (timeboxed) ∥ merge codex/feat-connection-scoping as-is (D7)
Wave 1  WP-TENANT (D7 follow-up org partition, D8 builders, D9 mode, D10 envelope store)
        ∥ WP-OPS (D11 pipelines, D12 Sentry, D13 reaper, D14 migrations)
        ∥ org-management UI (D2 — invites/members/roles in-app)
Wave 2  WP-BILLING (orgs fields, applyPolarState, webhook+checkout routes, requireEntitlement gate,
        seat flow, settings/plan UI)
Wave 3  Full staging rehearsal — signup → org → invite → subscribe (trial) → cloud workspace →
        seat over-add blocked→purchased → cancel → entitlement revokes. GATE FOR CHARGING REAL MONEY.
```

## §4 — Standing invariants

- I-1 Self-host stays free, zero new required env, Clerk/Polar-free; Worker import-graph guard green (Polar confinement per D4).
- I-2 `embedded-auth.ts` self-host behavior unchanged; `auth-client.ts` exported surface frozen (D3).
- I-3 Polar webhooks single writer of subscription state; signatures verified; reconciliation sweep active before launch.
- I-4 Fail-closed everywhere: unknown subscription = free; unverifiable token = 401; hosted boot refuses partial config (D9).
- I-5 No credential value/PII beyond IDs in Convex, logs, telemetry; envelope encryption before any hosted credential row exists (D10).
- I-6 No PRs/pushes to upstream `anomalyco/opencode`; origin `kyashrathore/Claxedo` only.

## §5 — Owner decisions still open

- ~~OQ-1 annual price~~ — RESOLVED 2026-07-12: **$89/yr** ("2 months free").
- OQ-2 Device-code CLI login: buildable as first-party broker on Clerk sessions (control plane already mints CLI JWTs); in-scope when `claxedo up`/channels demand it — not launch-blocking. If it proves unbuildable on Clerk, that is migration trigger T-c.
- OQ-3 Relay deploy tunnel-drop window acceptable at launch (lean yes; revisit ~200 seats — triggers in 016 §6).
- OQ-4 `past_due` grace period (suggest 7 days).

## §6 — Progress log

| Date | Item | Evidence | Result |
|---|---|---|---|
| 2026-07-11 | ADRs 013–016 authored; cross-checked consistent | docs exist; grep cross-check | — |
| 2026-07-11 | Owner review: D1 reversed to keep Clerk; 013/014 addenda; S1 cancelled; plan re-sequenced | 013/014 addenda; this rev | plan ready, S2 pending |
| 2026-07-12 | OQ-1 resolved: annual = $89/yr | owner decision | Polar products unblocked |
| 2026-07-12 | Wave 1 (D8/D9/D10/D11), Wave 1b (D7/D12/D13/D14), Wave 2 (billing) landed | commits dbb7896f8..01ba51a16d, each leader-gated | server-side spine complete |
| 2026-07-12 | Adversarial review: 5 finders → 2-skeptic verify (19 verdicts, 0 refuted); doc 2026-07-12-001 | review commit | 19 confirmed findings |
| 2026-07-12 | Review fixes F6/F7/F15 landed; F1-F5/F8-F19 tasked | review-fix commit | P0 F1-F5 open |
