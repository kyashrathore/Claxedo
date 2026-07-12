# Adversarial review — cloud-subscription launch branch

Date: 2026-07-12
Reviewed: branch `feat/cloud-subscription-launch`, base `09c3aca630` → tip `01ba51a16d` (9 commits, plans 012–016 + Waves 1/1b/2).
Method: 5 adversarial finders (5 angles) → dedup → 2 independent skeptics per material finding → each attempts refutation with counter-evidence. **19 completed verify verdicts, 0 refuted.** Synthesis authored by leader from the journal (workflow synthesis step was credit-blocked).

Severity legend: **P0** = blocks charging real money · **P1** = fix before broad launch · **P2** = correctness/hygiene.

---

## P0 — launch-blocking

### F1. Seat hard-block is in the Clerk webhook mirror — wrong layer (D6)
`convex/orgs.ts:196-206` calls `enforceSeatCapacity` inside `upsertClerk…` (the Svix-verified Clerk→Convex mirror). Consequences: (a) the member already exists in Clerk when the block throws, so it does not block the join; (b) the throw 500s the Svix delivery, which wedges the **entire** Clerk mirror — including membership *revocations* — until Clerk sync recovers; (c) the over-cap member keeps a valid JWT `org_id` claim and passes the connections gate. There is no inline seat-purchase surface (the other half of D6). This is an unexamined ripple of the Clerk-retention reversal: D6 was designed against a Better-Auth first-party membership write, not the Clerk mirror. **Fix:** move the block to an add-time choke point (invite/accept mutation), or — since Clerk owns membership — enforce seats at the *entitlement* layer and treat Clerk membership count as advisory. Needs a design call; interacts with the deferred org-management UI.

### F2. Checkout has no already-subscribed guard → double-billing
Nothing blocks `POST /api/billing/checkout` for an org that already holds a live subscription, and no mid-cycle seat-increase path exists. The only "buy more seats" flow mints a **second** Polar subscription for the same org. **Fix:** guard checkout when `subscription_status ∈ {active,trialing,past_due}`; route seat changes to a Polar subscription-update call. Depends on S2 (Polar seat-update semantics).

### F3. Cancellation does not revoke existing cloud workspaces
`requireEntitlement("cloud-workspace")` is consulted only at workspace *create* (`routes/hosted-workspace.ts`). After cancel, existing cloud workspaces stay wake-able and usable indefinitely. **Fix:** check entitlement at wake/resume (sandbox lease acquisition is the natural choke point), not only at create.

### F4. Deleting an org with a live subscription bills forever
Org delete does not cancel the Polar subscription, and the reconciliation sweep *excludes* deleted orgs — so the ADR's "reconciliation backstop" claim (014 §3) is false for this path. Customer charged in perpetuity. **Fix:** org-delete must cancel in Polar synchronously; reconciliation should include recently-deleted orgs with a live `polar_subscription_id`.

### F5. hosted-connections entitlement gate is dead code
`requireHostedConnectionsEntitlement` is an optional `ConnectionsHostOptions` field consulted only when supplied (`connections-host.ts:163-166`); the sole production `createConnectionsHost` call (`server.ts:406-410`) never passes it. So the paid gate is unenforced — flipping the D7 `CLAXEDO_HOSTED_CREDENTIALS_ENABLED` flag would serve paid connections to free orgs — and personal-org subscribers can never use the capability. *Mitigant:* the D7 503 hard floor (default-off) keeps the whole surface dark in production today, so this is latent, not live. **Fix:** wire the hook fail-closed in the composition.

### F6. Reconciliation flag can never clear in steady state
`convex/billing.ts:103-105` returns `stale_source` (before any write) when `input.source_ts <= org.polar_state_modified_at`. The reconciliation source re-sends Polar's *existing* `modified_at`, so for an unchanged subscription the sweep can never clear `billing_reconcile_flagged_at` or refresh `billing_synced_at`. Every subscribed org converges to permanently-flagged and is re-fetched from Polar every 15 min forever; worse, a cancellation first observed via the sweep can be blocked by the same guard. **Fix:** on a stale/equal no-op from the *reconciliation* source, still clear the flag and stamp `billing_synced_at` — those are "we checked" bookkeeping, distinct from subscription-state writes.

---

## P1 — before broad launch

- **F7. Unattributable webhook silently 2xx-acked.** A `subscription.*`/`customer.*` event whose org can't be resolved is 202-acked with no `reportPaymentError` (the code comment claims it reports; it doesn't). Combined with **no persisted checkout→org linkage** and orgs lacking `polar_customer_id` being invisible to the sweep, a paid-but-never-entitled org has zero backstop. Fix: persist the org↔customer link at checkout creation (metadata.org_id is set — mirror it on our side pre-webhook), and page on unattributable events.
- **F8. Node hosted boot skips the credential-backend + org-partitioning assertions** the plan promises (012:29, 015 §4). Hosted mode + flag on the *Node* server writes hosted org credentials to the local file store, bypassing the envelope-KV path (undoing D10 in that composition). Fix: extend `assertHostedBootRequirements` to assert the credential backend is the encrypted-KV one when hosted.
- **F9. Billing identity is the purchasing admin's Clerk subject, not the org.** `external_customer_id` = the admin who first checked out. Non-purchaser admins get 502 on `/portal`; cancel/invoices reachable only by the original purchaser; a second admin's checkout mints a second Polar customer. Fix: key the customer on the org (stable external id = `org_{id}`), not the human.
- **F10. `seats_licensed` unrecoverable after a missed `subscription.*` webhook.** Customer-state omits seats and `preserve_seats` keeps the old count, so reconciliation can never re-derive seats — seat enforcement silently disabled for that org. Fix: reconciliation should read seats from the subscription object in customer-state (S2 to confirm it's present there).
- **F11. `past_due` grace re-anchors on every dunning webhook.** Grace is measured from when past_due last landed on the mirror; each dunning retry refreshes it, so a non-paying org keeps access for the whole dunning cycle, not N days. Fix: anchor grace on the *first* past_due transition (or on `current_period_end`).
- **F12. D2 vs D7 contradiction.** D2 says "JWT org claims are hints, never authorization inputs"; the D7 connections partition authorizes team access purely from the Clerk-verified `org_id` claim with no Convex membership re-check. The claim is Clerk-signed so it's not forgeable by a user, but a stale/mis-synced claim grants team-connection access. Fix: re-check org membership in Convex at the connections gate, or explicitly amend D2's wording to "verified claims are authoritative."

---

## P2 — correctness / hygiene

- **F13. Business math stale after the annual price change.** "$6.55 contribution / ~780 seats → $5K/mo" is the all-monthly, US-card case. $89/yr nets ≈$5.50/seat-mo; a realistic annual mix moves break-even to **~830–930 seats**. Doc-only fix in 012/pricing memory.
- **F14. D6 mechanism silently switched from "quantity" to Polar's seats feature** with no ADR addendum — ADR 014 §4 (line 150) still says "plain subscription quantity." The billing worker did discover Polar SDK 0.48.1 exposes `seats` not `quantity` and marked it S2-pending in code, but the ADR body was never reconciled. Fix: add the addendum.
- **F15. Convex service-token compared with `!==`** (non-constant-time) while the webhook verifier and the rest of the repo use a timing-safe compare. Fix: use the constant-time helper.
- **F16. Credential envelope omits GCM AAD.** Ciphertext isn't bound to its storage id, so within-org relocation/rollback of a blob is undetectable under the exact "leaked KV token" threat D10 names. (Confidentiality + per-blob tamper-evidence still hold.) Fix: pass the KV id (and key-id) as AAD.
- **F17. Reconciliation starved by sandbox-GC failure** — the billing sweep runs after GC in the same scheduled handler; a persistently failing GC blocks the downgrade-recovery path. Fix: isolate the two sweeps (independent try/catch, or separate cron).
- **F18. Auto-staging deploys Convex with typecheck disabled + no dry-run**, bundling schema with Worker code — bypassing the gates `deploy-convex.yml` encodes. Fix: run the same dry-run/typecheck gate in the staging path.
- **F19. metadata-less `customer_state` falls back to `Date.now()`**, defeating the replay/stale guard for such payloads. Fix: reject/park payloads without a usable source timestamp rather than stamping now.

---

## Note on gate integrity (reviewer challenge, adjudicated)
The review flagged `services.test.ts` as having 2 deterministic failures — **true**, but they pre-exist at base `09c3aca630` (the test references `packages/claxedo-app/src/utils/session-url.ts`, removed by the parent branch's WP-D5 utils/ dissolution). Not caused by the subscription work; the targeted gate lists deliberately excluded that file. The "104/104" etc. claims were reproducible against the exact file lists gated. No fabrication, but the standing gate should track this pre-existing red so it isn't mistaken for new.

## Disposition
- Fixed this session (self-contained, unambiguous): **F6, F15** (+ F7 reporting).
- Routed to tasks (design-level or S2/owner-blocked): F1–F5, F8–F14, F16–F19.
