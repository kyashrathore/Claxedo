# ADR — WP-BILLING: Polar subscription billing for Claxedo Cloud

Date: 2026-07-11
Status: **proposed** — all four decisions recommended below; execution blocked only on spike S2 (§6.3)
Siblings: the cloud subscription launch plan (this ADR is the design record behind its WS-B), doc 013 (Better Auth migration design — the auth stack this billing design rides on)
Scope of this document: architecture decisions and their reasoning. NOT an edit map, NOT a stage plan — the launch plan owns sequencing.

Fixed business decisions (inputs, not up for re-litigation here):

- **$9/mo and $89/yr per seat**, same flat price for individuals and teams. An individual is an org of 1 — and the data model already agrees (see §1).
- **Polar as Merchant of Record**, on the 5% + $0.50/txn tier for orgs created after 2026-05-27 ([polar.sh/docs/merchant-of-record/fees](https://polar.sh/docs/merchant-of-record/fees)). Polar owns tax, invoices, refund execution, disputes.
- **Per-seat = registered org member.** No usage metering, ever, in this design.
- **Users bring their own VM and their own AI keys.** Claxedo sells the hosted control plane: identity, sync, relay, cloud workspace orchestration, hosted connections.
- **Self-host stays free and Polar-free.** Any design that leaks a Polar dependency into the self-host default path is wrong by construction (invariant I-1).

---

## 1. Starting position appraisal

### 1.1 What exists

There is **zero billing code** in the repository. No payment SDK in any lockfile, no plan/subscription/entitlement field in any of the 18 tables in `convex/schema.ts`, no checkout or webhook surface. What *does* exist is a clean, billing-shaped substrate:

- **`orgs` + `org_memberships`** (`convex/schema.ts:22-45`) are exactly the attachment points a per-seat model needs: an org row to hang `polar_customer_id` and `seats_licensed` on, and a membership table whose row count *is* the seat consumption. The `by_org_user` index makes "current member count" a cheap indexed read.
- **Personal orgs are auto-created.** `ensureOwnerOrg` in `convex/workspaces.ts:20-43` guarantees every user has a personal org with an owner membership before their first workspace exists. "Individual = org of 1" is therefore not a billing-layer fiction we have to maintain — it is already the identity model. One subscription shape (org-attached, quantity ≥ 1) covers every customer.
- **Hosted capability creation funnels through single choke points.** Cloud workspace creation on the hosted control plane is one route (`packages/claxedo-server/src/routes/hosted-workspace.ts` `/create`, which calls `authority.createCloudWorkspace`) behind the typed `WorkspaceAuthority` port (`packages/claxedo-server/src/control-plane/authority.ts`). Connections routes already take injected `gate` / `tokenGate` hooks (`packages/claxedo-connections/src/routes.ts:9-18`) designed for exactly this kind of host-supplied policy. An entitlement check has natural, pre-existing seams to sit in; nothing needs restructuring to become gateable.
- **Plumbing patterns worth copying, not rebuilding:** fixed-window per-user rate limiting with refund semantics (`control-plane/rate-limit.ts`), request serialization + short-TTL idempotency caching (`control-plane/http-idempotency.ts`), and audit writes (`audit_events`). None of these are billing code, but they set the house style for the webhook and checkout surfaces.
- **A mechanical Worker boundary.** `packages/claxedo-server/src/worker.import-graph.test.ts` statically walks the Worker bundle graph and rejects Node-only modules. Whatever we decide below, this test is the enforcement mechanism that keeps billing code from silently breaking the CF Worker deploy.

### 1.2 Why greenfield is an advantage, not a gap

Most billing retrofits fight three battles this project doesn't have to: migrating existing paying customers across providers, dual-writing plan state during a transition window, and untangling entitlement checks that grew ad hoc inside feature code. We have zero customers, zero legacy invoices, and zero scattered checks. That means:

1. We can pick the **strictest single-writer architecture** (webhook → Convex mirror, §3) without a migration story.
2. We can define **one entitlement predicate from day one** instead of retro-hunting gates. Every future hosted capability inherits it.
3. The Clerk→Better Auth migration (doc 013) is happening at the same time, so billing can bind to the *final* auth stack rather than to one being deprecated. There is no "temporary Clerk-era billing glue" to write and then unwind.

### 1.3 What is structurally missing

Three concepts, all absent, all cheap to add precisely because nothing contradicts them yet:

- **A plan concept.** Nothing distinguishes a free org from a paying org. Needed: plan + subscription-status + seats fields on `orgs` (B1 names them).
- **An entitlement concept.** Authorization today answers "who are you and what is your role" — never "what has your org paid for." Needed: one server-side predicate (`requireEntitlement(orgId, capability)`) consulted at the choke points in §1.1.
- **A billing-state writer.** No inbound webhook surface writes org state (the Clerk mirror in `convex/orgs.ts` is being deleted with doc 013). Needed: exactly one module that translates Polar events into Convex org-field writes — and nothing else that ever writes those fields.

---

## 2. Decision 1 — Integration surface

### Option A — `@polar-sh/better-auth` plugin

**How it works.** The plugin mounts on the Better Auth server instance and provides sub-plugins: `checkout` (creates checkout sessions for configured products), `portal` (customer self-service for invoices/cancel/payment methods), `webhooks` (signature-verified endpoint at `/api/auth/polar/webhooks` with ~25 typed handlers plus an `onPayload` catch-all), and `usage` (irrelevant here — no metering). `createCustomerOnSignUp` creates the Polar customer at user registration and links it via `externalId`, eliminating a hand-rolled user↔customer mapping table. Docs: [polar.sh/docs/integrate/sdk/adapters/better-auth](https://polar.sh/docs/integrate/sdk/adapters/better-auth).

**Why good.** It rides the auth stack doc 013 is installing anyway, so billing gets customer lifecycle, checkout, portal, and verified webhooks for roughly configuration-cost. The customer identity problem — the perennially fiddly part of billing integrations — is solved by construction (`externalId` = Better Auth user id). Signature verification (Standard Webhooks) comes built in rather than hand-rolled.

**Why bad / tradeoffs.**
- *Coupling billing to auth-stack lifecycles.* The plugin's version lattice is `better-auth` × `@polar-sh/better-auth` × `@polar-sh/sdk`. A Better Auth major upgrade can now be blocked by the Polar plugin lagging, and vice versa. Mitigation is the discipline this repo already uses for third-party spines (tokentracker precedent): exact-pin all three, upgrade as a set, behind tests.
- *Framework assumptions.* We are Solid + Hono, not Next.js. Server-side this is a non-issue: the plugin extends the Better Auth server instance, which mounts on Hono natively; Polar's own docs show no Next.js requirement and reference Workers-adjacent deployments. Client-side, `@polar-sh/better-auth/client` extends the framework-agnostic Better Auth client, which the Solid app will already consume for auth (A4). Residual risk is "works in principle, unverified in our exact stack" — that is a named S2 exit criterion, not a design unknown.
- *Where webhooks run.* The plugin's webhook route lives wherever Better Auth serves — per spike S1's default lean, a small Fly Node service, **not** the CF Worker. That is the right place anyway (see recommendation), but it means billing-state freshness inherits the auth service's availability (§3 handles this).
- *Route ownership.* The webhook path is plugin-owned (`/api/auth/polar/webhooks`); we don't control its middleware stack. Acceptable because the handler body is ours.

### Option B — raw `@polar-sh/sdk` + own webhook route in the control plane

**How it works.** Call the SDK directly for checkout-session creation and portal links; mount our own Hono route for webhooks, verifying with the SDK's Standard-Webhooks `validateEvent` helper ([polar.sh/docs/integrate/webhooks/delivery](https://polar.sh/docs/integrate/webhooks/delivery)). The SDK is a thin typed wrapper over `fetch` with a pluggable fetcher ([npmjs.com/package/@polar-sh/sdk](https://www.npmjs.com/package/@polar-sh/sdk)), so it is Worker-compatible if we ever want the webhook route on the CF Worker.

**Why good.** No plugin version lattice; total control of route placement and middleware; the pluggable fetcher makes CI mocking trivial; Worker placement stays open.

**Why bad.** We re-implement what the plugin gives free: customer-on-signup (now an explicit hook in our signup flow that can partially fail — the known better-auth issue class where customer creation errors while user creation succeeds becomes *our* error-handling problem in both directions), checkout wiring, portal-link plumbing, and webhook mounting. More surface, same outcome, and the user↔customer linkage becomes our code instead of `externalId` convention.

### Option C — Polar-hosted checkout links only, minimal code

**How it works.** Static checkout links per product; Polar's hosted pages do everything; we consume webhooks only (or worse, poll).

**Why good.** Near-zero integration code; fastest possible first sale.

**Why bad.** Fatal for this product shape: seat quantity changes must be driven **from inside the app** at the moment an admin adds a member (§4). Static links can't carry per-org quantity mutations, can't pre-associate the org, and force the customer identity linkage through email-matching heuristics. It also still needs the webhook writer — so it saves only the checkout call, the cheapest part.

### Recommendation

**Option A — the Better Auth plugin — with two structural conditions:**

1. **The webhook handler body is a one-call shim.** Every plugin handler delegates to a single `applyPolarState(orgId, state)` module (§3). If the plugin ever becomes a liability (version deadlock, abandoned adapter), swapping to Option B is a re-mount of one route plus checkout-call rewiring — the state-application logic, the only code with real reasoning in it, doesn't move. Option B remains the documented fallback, and S2's plugin-verification exit criterion is what keeps us honest about pulling that ripcord early rather than late.
2. **The CF Worker imports nothing Polar.** Checkout, portal, and webhooks all live on the auth service; the Worker's only contact with billing is reading mirrored entitlement fields through the existing authority port. `worker.import-graph.test.ts` gets `@polar-sh/sdk` and `@polar-sh/better-auth` added to `FORBIDDEN_BARE` so this is mechanically enforced, not reviewed-for. (The SDK *is* fetch-based and Worker-safe; we forbid it anyway because nothing in the Worker should need it, and an accidental import means someone put billing logic in the wrong tier.)

**Blast radius when Polar is down:** new checkouts and portal visits fail — sales are paused, which is Polar's outage to own as MoR. Entitlement checks are unaffected because they never touch Polar at request time (§3). This asymmetry — "can't buy" degrades gracefully, "can't use what you bought" must never happen — is the main reason Options A and B are configured identically on the read path, and the reason Option "query Polar live" loses in the next section.

**Testability in CI without Polar:** webhook handlers are exercised with Standard-Webhooks-signed fixture payloads against `validateEvent` (secret is just a test constant); checkout/portal calls are covered by injecting a mock fetcher into the SDK client. No CI job ever needs Polar sandbox credentials; the only thing that genuinely requires the live sandbox is spike S2 itself.

---

## 3. Decision 2 — Where subscription state lives, and how entitlement derives from it

### Options

**(a) Mirror Polar state into Convex `orgs` fields, webhook as the single writer.** Polar events land on the webhook route; one module writes `plan`, `subscription_status`, `seats_licensed`, `polar_customer_id`, `polar_subscription_id`, `current_period_end` onto the org. Entitlement is a pure function of the org row, evaluated wherever authorization already reads Convex.

**(b) Query Polar at request time.** Entitlement checks call Polar's API (with a short cache) whenever a gated route runs.

**(c) Short-lived signed entitlement tokens.** A minting service reads Polar state and issues signed capability tokens the app presents to enforcement points.

### Reasoning

**Staleness and its actual product consequences.** Option (a)'s staleness window is webhook propagation: seconds normally, and Polar retries failed deliveries up to 10 times with exponential backoff ([webhooks/delivery](https://polar.sh/docs/integrate/webhooks/delivery)). Walk the two directions of staleness:

- *Entitlement granted late* (customer paid, mirror not yet updated): a new subscriber stares at a locked "create cloud workspace" button for a few extra seconds. The checkout success page can poll the org's plan field; worst case is a short "activating…" spinner. Annoying, self-healing, zero revenue impact.
- *Entitlement revoked late* (subscription revoked, mirror stale): a canceled org keeps hosted access for minutes-to-hours. The marginal cost is a rounding error (their compute is their own VM; our exposure is relay bytes and control-plane reads), and `subscription.revoked` fires at period end for normal cancellations anyway — the state was "paid through today" moments earlier.

Per-seat billing with no metering is precisely the product shape where staleness is cheap. There is no usage counter to defraud during the window. That cheapness is what makes (a) viable at all — a metered product couldn't tolerate it.

**Webhook delivery failure and replay (idempotency).** Polar retries on non-2xx/timeout, and deliveries can arrive more than once and — since the events docs make no ordering promise ([webhooks/events](https://polar.sh/docs/integrate/webhooks/events)) — potentially out of order. The design answer is to make the writer **state-applying, not event-interpreting**: key on `customer.state_changed`, which carries the customer's full current state (active subscriptions + granted benefits), and treat the granular `subscription.*` events as triggers for the same "recompute org fields from embedded state" routine, guarded by a stored `polar_state_modified_at` timestamp so an older replay can never overwrite a newer write. Last-write-wins-by-source-timestamp makes duplicates and reordering harmless *without* a durable processed-event-id table. (The in-memory `cachedIdempotency` helper in `control-plane/http-idempotency.ts` is the house pattern for request-level dedupe, but it is per-isolate and 5-minute-TTL — fine for API idempotency, not a substitute for this; the timestamp guard is the real mechanism.)

**The failure mode webhooks alone can't cover.** Polar **disables an endpoint after 10 consecutive failed deliveries** and requires manual re-enable ([webhooks/delivery](https://polar.sh/docs/integrate/webhooks/delivery)). An auth-service outage long enough to burn the retries doesn't just delay events — it silently stops all future ones. Therefore mirror-via-webhook must ship with a **reconciliation sweep**: a scheduled job (Convex cron, same slot as the D3 reaper) that lists orgs with a `polar_subscription_id` and re-fetches their subscription state from Polar's API, plus an admin-triggered "refresh billing state" for support situations. Reconciliation converts "webhook endpoint quietly dead" from an unbounded correctness bug into a bounded-staleness blip, and it doubles as the drift detector for §4's seat-count invariant.

**Why not (b), query-at-request-time.** It puts a third-party API on the hot path of every gated route: added latency on workspace creation, Polar rate limits as *our* throughput ceiling, and — decisive — a hard availability coupling. When Polar is down, (b) forces an ugly choice per-request: fail open (paid features free for the duration, and an incentive for attackers to induce timeouts) or fail closed (paying customers locked out of what they paid for because a *billing* vendor blipped). Option (a) makes a Polar outage invisible to the product. The cache that makes (b) performant is just a worse-behaved version of (a)'s mirror — same staleness, less control, no audit trail.

**Why not (c), signed entitlement tokens.** Tokens earn their complexity when enforcement points can't reach the state store. Our enforcement points — hosted workspace routes, connections gates — already perform Convex-backed authority reads on every request; entitlement piggybacks on a read that is already happening, for free. Tokens would add a minting endpoint, key rotation (a second JWKS-style lifecycle beside `control-plane/routes/jwks.ts`), TTL-vs-revocation-lag tuning, and client plumbing — to solve a distribution problem we don't have. *Future note:* if entitlement enforcement ever needs to happen inside the relay data path (which deliberately avoids per-frame Convex reads), (c) is the right retrofit, minted from the same Convex mirror. The mirror is a prerequisite for the token design anyway; nothing is foreclosed.

**Why fail-closed-to-free-tier is the right failure semantics.** Invariant I-4 says unknown state = free tier; this ADR supplies the reasoning. The free tier (§5) is *self-host-equivalent*: local workspaces, BYO everything. So when billing state is unknown — org row predates billing, webhook writer wedged, reconciliation mid-flight — the customer degrades to exactly what a self-hoster has: the product still works, their local workspaces and keys are untouched, they lose only the hosted extras. That is **degradation, not lockout**, which is what makes fail-closed defensible as a *default* rather than a support-ticket generator. Contrast the alternatives: fail-open means the ambiguous state is the profitable one to induce (and unknown-state bugs become silent revenue leaks nobody reports); fail-closed-to-*nothing* means a billing hiccup bricks a customer's workflow, which for a developer tool is churn fuel. Free-tier-as-floor also has a clean mental model to communicate: *paying is what turns hosted features on; nothing you didn't pay for can be taken away.* The one sharp edge — a paying team hitting a false "unknown" during an incident and losing cloud-workspace access mid-work — is bounded by grace handling on `past_due` (OQ-4 suggests 7 days) and by reconciliation being admin-triggerable; the entitlement predicate should treat `past_due`-within-grace and `trialing` as entitled, and only `none/canceled/revoked/unknown` as free.

### Recommendation

**(a): Convex mirror, webhook single-writer, state-applying handlers keyed on `customer.state_changed` with a source-timestamp guard, plus a scheduled + admin-triggerable reconciliation sweep against Polar's API. Entitlement = pure function of the org row, exposed as one `requireEntitlement(orgId, capability)` predicate behind the existing authority/gate seams. Unknown resolves to free.**

---

## 4. Decision 3 — Seat enforcement model

### Options

- **Hard-block:** adding an org member beyond `seats_licensed` is refused; the admin is shown an inline "add a seat" purchase step; the member add completes after the webhook confirms the new quantity.
- **Soft-allow + monthly true-up:** members join freely; a periodic job counts membership and adjusts the Polar subscription quantity (or issues a catch-up charge) after the fact.
- **Trust-and-reconcile:** seats are whatever the admin claims to have bought; drift is detected occasionally and chased manually.

### Reasoning

**Buyer expectation anchors.** The teams buying a $9/seat developer tool live inside GitHub's model daily: GitHub org seats and Copilot Business both require an available license *before* a member/assignment lands, charge prorated for mid-cycle additions, and apply removals at the next cycle. Cursor's team plan behaves the same way (seat count gates invites; additions prorate). Hard-block at add-time is therefore not perceived as friction — it is the *expected* mechanic, provided the block is an inline purchase step rather than a dead end. The friction to actually fear is the opposite failure: an invoice at month-end for seats nobody remembers approving, which is the true-up model's signature UX.

**Revenue leakage.** Soft-allow leaks a partial month per over-added seat, forever, structurally. At $9/seat that is small per incident but it compounds with team count, and — worse — it converts "billing is correct" from an invariant into a reconciliation report someone has to read. Trust-and-reconcile is the same leak without the report.

**Engineering cost — the decisive axis.** Hard-block is the *cheapest* option, not the most expensive, because of what already exists: current seat consumption is an indexed count of `org_memberships`, `seats_licensed` is one mirrored field (§3), and the check is one comparison at the single member-add path (post-doc-013, Better Auth org lifecycle hooks are that path). Soft-allow, by contrast, requires a metering-shaped subsystem — periodic counting, delta computation, retroactive charging, dispute handling for the surprise line items — which the fixed decisions explicitly reject ("per-seat, NO usage metering"). True-up is metering with a monthly clock. Choosing soft-allow would smuggle back in exactly the machinery per-seat pricing was chosen to avoid.

**How Polar's mid-cycle behavior pushes the choice.** Polar's current docs state that seat additions charge immediately, prorated for the remainder of the period, and reductions issue a prorated credit ([polar.sh/docs/features/seat-based-pricing](https://polar.sh/docs/features/seat-based-pricing)). But community reviews have flagged Polar's mid-cycle subscription handling as historically weak, and the seat/quantity mechanics are recent. This cuts *for* hard-block: the model's only Polar dependency is "increase quantity now, charge prorated now, emit a webhook" — one narrow, testable interaction. Soft-allow depends on the *broader and weaker* surface (retroactive adjustments, credit accumulation across multiple drifts). If mid-cycle quantity updates turn out flaky, hard-block degrades loudly and safely (the admin's purchase step errors; nobody gets an unbilled seat), whereas true-up degrades silently (drift accumulates against a broken adjustment path). Validating that narrow interaction is precisely spike S2 (§6.3), and it blocks WS-B.

**Quantity vs Polar's seat-assignment feature.** Polar now offers full seat-based pricing — invitation emails, pending/claimed/revoked seat states, `customer_seat.assigned/claimed/revoked` webhooks ([seat-based-pricing](https://polar.sh/docs/features/seat-based-pricing)). We should use **plain subscription quantity and ignore the assignment layer**: org membership in Better Auth/Convex is already the truth about who is on the team, with its own invite flow (A4). Adopting Polar's seat assignments would create a second membership system — 24-hour invitation links, claim states, a `member` object — that must be kept in lockstep with ours, doubling every join/leave flow's failure modes. The dividing line: **Polar owns "how many seats are paid for"; Claxedo owns "who occupies them."** The two meet only at the hard-block comparison and the reconciliation sweep (alert if `count(org_memberships) > seats_licensed` ever drifts true outside an in-flight add).

**Seat reduction.** Allowed any time, floor = current member count (must remove the member first — mirroring Polar's own "reduce the count, don't just revoke the assignment" semantics); prorated credit per Polar's documented behavior; takes effect immediately on the mirror via webhook. No grace machinery needed.

### Recommendation

**Hard-block with an inline seat-purchase step, implemented as one comparison against the §3 mirror at the single member-add path; plain subscription quantity, not Polar seat assignments; reduction floor at current membership; drift alarmed by the reconciliation sweep. Contingent on S2 confirming the quantity-update path (§6.3) — if S2 fails, the fallback is Polar's seat-based-pricing feature (accepting the dual-membership cost), not soft-allow.**

> **ADDENDUM 2026-07-12 (F14, implementation reconciliation).** During Wave-2 build the SDK (`@polar-sh/sdk` 0.48.1) was found to expose **`seats`** on checkout/subscription and **no plain `quantity` field anywhere** — so the "plain subscription quantity" phrasing above is superseded: the implementation lands on Polar's **seats** field, which is the ADR's own pre-decided fallback rung, not a new decision. Marked `S2-PENDING` in `apply-polar-state.ts`/`convex/billing.ts` and confirmed by adversarial review (F14). Two adversarial-review corrections that stay OPEN against this section, tracked in `2026-07-12-001` and the task list, NOT yet implemented: **(F1)** the member-add hard-block currently lives inside the Clerk webhook mirror (`convex/orgs.ts`), which is the wrong choke point — it wedges the mirror instead of blocking the join and needs an add-time relocation (product decision on seat-buying UX pending); **(F2)** the checkout route has no already-subscribed guard and no mid-cycle seat-increase path, so a second purchase double-bills — the seat-increase must route to a Polar subscription-update, which is exactly what S2 must confirm.

---

## 5. Decision 4 — What the free tier IS, architecturally

### Proposed line

**Free = self-host-equivalent.** A free hosted account gets identity, a personal org, and local workspaces — the app working against the user's own machine with their own keys, i.e. everything the free self-host build provides, plus nothing. **Paid unlocks the hosted deltas:** cloud workspace creation/orchestration (`routes/hosted-workspace.ts` `/create` and the sandbox lease machinery behind it), hosted connections (the `claxedo-connections` gates on the hosted control plane, including the org-scoped hosted credential store from C2), and relay-backed capabilities (user-hosted workspace links through the hosted relay). Everything gated by the one `requireEntitlement` predicate from §3.

### Why draw it there

**Cost incidence.** A free user on this line costs approximately nothing: a handful of Convex rows and auth reads — no sandbox leases, no relay tunnels, no hosted credential storage. The gated set is *exactly* the set of features with nonzero marginal cost (relay bytes, sandbox orchestration, KV credential storage, the ~$1.50/seat/mo variable infra in the launch plan's unit economics). The free tier can therefore scale to any size without a cost cliff, and no abuse vector exists worth engineering against — there is nothing to farm. Contrast N-free-cloud-sessions: it hands out metered-cost resources to unauthenticated-quality accounts (sandbox time is a classic cryptominer target), and enforcing "N sessions" requires counting sessions per org per period — a metering-lite subsystem the fixed decisions reject, plus reset semantics, plus "does a crashed session count" support tickets.

**Funnel logic.** Self-host is free forever and shares this codebase by design — it is the top of the funnel, not a competitor. That creates a squeeze on where the free hosted tier can sit: it cannot be *less* than self-host (why would anyone create a hosted account?) and must not be *more* (a free hosted tier with cloud sessions would undercut the only thing being sold — the paid tier — while self-host already sets the "free" anchor). Free-equals-self-host-parity is the unique stable point: the hosted free account is the same product with a lower setup cost, and the paid line captures precisely the capabilities self-host cannot replicate without the user running their own control plane. The upgrade pitch writes itself as a capability list, not a quota negotiation.

**Architectural simplicity.** This line means the free tier requires **zero new enforcement machinery** — it is the fail-closed floor from §3. Free tier = entitlement predicate returns false = hosted-extra routes refuse. One boolean per capability, no counters, no cliffs, no quota state to store or reset. The free tier isn't a configured plan; it is the *absence* of one, which is also why unknown-state safely resolves to it.

### Alternatives considered

- **Time-boxed trial as the only free experience** (no permanent free hosted tier): rejected. It re-introduces lockout semantics (§3's degradation argument dies — trial expiry bricks the account), and it makes the fail-closed floor "nothing," which poisons the failure-mode story for *paying* customers too.
- **N-cloud-sessions cap:** rejected per cost-incidence and metering-lite arguments above.

### Whether a trial exists at launch

**Yes — a 14-day trial on the paid plan, implemented entirely as Polar-native trial configuration, not Claxedo code.** Polar supports trial periods configured on the product or checkout session; it collects the card at checkout, charges automatically when the trial ends, sends trial-ending reminder emails, and offers built-in trial-abuse prevention (email-alias normalization + payment-fingerprint tracking) — all "without your code in the loop" ([polar.sh/docs/features/subscriptions/trials](https://polar.sh/docs/features/subscriptions/trials)). On our side the trial is invisible except as one more entitled status: the subscription arrives via webhook with a trialing state, the §3 mirror stores it, and the entitlement predicate treats `trialing` as paid. Rationale: the permanent free tier deliberately *cannot* demonstrate the hosted value (that is the point of the line), so something has to let a team taste cloud workspaces and connections before committing — and Polar gives us that for a product-settings toggle plus one status-mapping branch. Card-at-checkout keeps trial quality high (it filters tourists), which matters more than top-of-funnel volume for a $9 product with a real free tier below it. If S2 surfaces any surprise in how trialing subscriptions present in customer state or interact with seat quantity, launching *without* the trial is a one-line product-config change — the architecture is identical either way, which is exactly why this is the safe call.

---

## 6. Risks, failure modes, deliberate non-goals

### 6.1 Risks and failure modes

- **Webhook endpoint auto-disable (the sneaky one).** 10 consecutive failed deliveries and Polar disables the endpoint until a human re-enables it ([webhooks/delivery](https://polar.sh/docs/integrate/webhooks/delivery)). An auth-service deploy gone wrong burns retries fast (Polar times out deliveries at 10s and wants 2s responses — another reason handlers must be thin shims that ack fast and do minimal work inline). Mitigations, both required: alerting on webhook-delivery failure (rides the D2 Sentry floor) and the §3 reconciliation sweep as the correctness backstop. Without the sweep, this failure mode is unbounded; with it, it is bounded staleness.
- **Plugin version deadlock.** The `better-auth` × `@polar-sh/better-auth` × `@polar-sh/sdk` lattice can wedge (auth upgrade needed for a security fix, plugin lags). Mitigations: exact-pinning as a set, the one-call-shim handler discipline from §2 that keeps Option B a small swap, and treating "plugin unmaintained for one quarter" as the tripwire to execute that swap.
- **Seat/quantity mechanics are young.** Documented proration may not match sandbox behavior; the feature has beta history. This is not a launch risk because S2 (§6.3) blocks WS-B on validating it — the risk is only schedule, and the fallback ladder (quantity → Polar seats feature) is pre-decided in §4.
- **Split-writer temptation.** The single most likely long-term corruption of this design is a second writer of billing fields ("just flip the org to pro in the dashboard for this customer"). Support overrides must go through a distinct, audited field (e.g. a comped-until timestamp the entitlement predicate ORs in), never through the mirrored Polar fields — otherwise the reconciliation sweep will faithfully revert every manual favor, at the worst possible time.
- **Org lifecycle edges.** Deleting an org with a live subscription must cancel in Polar (the reconciliation sweep catches the miss, but the delete path should try synchronously); an org owner's user deletion mid-subscription needs the customer to survive (Polar customer is org-linked via subscription, user-linked via `externalId` — S2 should sanity-check the org-vs-user customer question in the plugin's `createCustomerOnSignUp` model, since our subscriptions attach to orgs while the plugin creates customers per user).
- **Margin nibbles, acknowledged not engineered around:** non-US cards carry an extra 1.5% pass-through on every plan; the 5%+$0.50 tier takes $9/mo to ≈$8.05 net. Both are priced into the launch plan's unit economics; neither changes architecture.

### 6.2 Deliberate non-goals

- **No usage metering.** Per-seat needs exactly one number Polar doesn't have — current member count — and that is an indexed Convex count we already store for authorization. Nothing to meter, aggregate, or window. Every option that would have required metering-shaped code (soft-allow true-up, N-session free caps, request-time billing) was rejected partly *on that ground* in §4/§5; this is a load-bearing simplification, not an omission.
- **No custom proration engine.** Proration is arithmetic over money we never hold — as MoR, Polar computes it, charges it, credits it, and owes the customer the explanation. If S2 shows Polar's proration is wrong, the answer is the §4 fallback ladder, never "compute it ourselves and issue adjustments."
- **No dunning beyond Polar's.** Polar owns retry schedules, card-update emails, and the `past_due` lifecycle. Our entire dunning surface is one status mapping: `past_due` within grace (OQ-4, suggested 7 days) stays entitled, then falls to free. No email sequences, no in-app payment nagging beyond a banner driven by the mirrored status.
- **No refund code.** Refunds are executed in the Polar dashboard (MoR obligation); they reach us as ordinary webhook state changes through the same single writer. No refund endpoint, no refund UI.
- **No entitlement tokens, no relay-path enforcement** at launch (§3 future note), **no billing on the self-host path** ever (invariant I-1), and **no Polar code in the CF Worker**, enforced by the import-graph guard.

### 6.3 Spike S2 — the one blocking unknown

Everything above is decided; one dependency is *asserted by documentation but unverified in practice*: Polar's mid-cycle seat-quantity behavior. S2 (§2) runs against a Polar sandbox org with the real $9/mo and $89/yr per-seat products and must answer, precisely:

1. **Quantity increase mid-cycle via API:** does it apply immediately; is the prorated charge attempted immediately; if the charge *fails*, is the quantity change rolled back, left applied-but-unpaid, or does the subscription go `past_due`? (Determines whether the §4 hard-block flow can safely complete the member-add on webhook confirmation, or needs a charge-outcome check.)
2. **Quantity decrease mid-cycle:** does the documented prorated credit materialize as a credit against the next invoice or as a refund; does it fire a webhook promptly?
3. **Webhook semantics for quantity changes:** exactly which events fire (`subscription.updated`? `customer.state_changed`? both?), what latency, and does the payload carry the new quantity and a usable state timestamp for the §3 guard?
4. **Plain quantity vs seats feature:** can a per-seat-priced product be driven by quantity alone, or does Polar's seat-based-pricing feature (and its beta/feature-flag gating) have to be enabled — and if so, can we use its count without its assignment layer?
5. **Plugin viability outside Next.js:** `@polar-sh/better-auth` checkout, portal, and webhook sub-plugins working against Better Auth mounted on Hono, with the Solid client — or the documented Option B fallback is invoked now, not later.
6. **Annual × seats × trial interactions:** a $89/yr subscription with quantity 3 adding a 4th seat mid-year prorates sanely; a trialing subscription reports a distinct, mappable status in customer state and its seat quantity behaves normally.

Exit artifact: a dated behavior note appended to this ADR recording each answer with sandbox evidence, plus the go/no-go on §2's plugin recommendation and §4's quantity model. Any "no" routes to the pre-decided fallbacks (Option B; Polar seats feature) — none of them reopen Decisions 2, 3, or 4.

---

## References

Repo grounding: `convex/schema.ts` (orgs/org_memberships/workspaces), `convex/workspaces.ts` (`ensureOwnerOrg`), `packages/claxedo-server/src/routes/hosted-workspace.ts` (`/create`), `packages/claxedo-server/src/control-plane/authority.ts` (WorkspaceAuthority port), `packages/claxedo-connections/src/routes.ts` (RouteGate seam), `packages/claxedo-server/src/control-plane/{http-idempotency,rate-limit}.ts`, `packages/claxedo-server/wrangler.toml`, `packages/claxedo-server/src/worker.import-graph.test.ts`.

Polar documentation (fetched 2026-07-11):
- Better Auth adapter: https://polar.sh/docs/integrate/sdk/adapters/better-auth
- Webhook events (incl. `customer.state_changed`, subscription lifecycle, event sequencing): https://polar.sh/docs/integrate/webhooks/events
- Webhook delivery (retries ×10 w/ backoff, 10s timeout, Standard Webhooks signatures, endpoint auto-disable after 10 consecutive failures, dashboard redelivery): https://polar.sh/docs/integrate/webhooks/delivery
- Seat-based pricing (assignment vs count, proration on add/reduce, 1,000-seat max, `customer_seat.*` webhooks): https://polar.sh/docs/features/seat-based-pricing and https://polar.sh/docs/guides/seat-based-pricing
- Trials (product/checkout-level config, card at checkout, auto-charge at trial end, abuse prevention): https://polar.sh/docs/features/subscriptions/trials
- MoR fees (5% + $0.50 for orgs created ≥ 2026-05-27; +1.5% non-US cards): https://polar.sh/docs/merchant-of-record/fees
- `@polar-sh/sdk` (fetch-based HTTPClient, pluggable fetcher): https://www.npmjs.com/package/@polar-sh/sdk

---

## ADDENDUM 2026-07-11 — Option B invoked: Clerk stays (see 013 addendum), so the better-auth plugin path is off

ADR 013's recommendation was reversed at owner review: Clerk remains the hosted issuer at launch, so there is no Better Auth service for `@polar-sh/better-auth` to mount on. **Decision 1 resolves to Option B (raw `@polar-sh/sdk` + own webhook route) — the pre-planned fallback this ADR priced in from the start.** Decisions 2–4 (Convex mirror w/ webhook single-writer + reconciliation sweep; hard-block seats on plain quantity; free = self-host-equivalent; 14-day trial) are unaffected — the `applyPolarState` module was designed integration-agnostic for exactly this.

Deltas vs the plugin path:
- **Customer linkage:** no `createCustomerOnSignUp`; the Polar customer is created lazily at first checkout with `external_customer_id` = Clerk user id (checkout-session API supports external customer ids). This also dissolves the org-vs-user customer question flagged in §6: the customer is the org OWNER's user id; the subscription attaches to the org in our mirror regardless.
- **Where the webhook route lives:** with no Fly auth service, the candidates are (a) the CF Worker itself — `@polar-sh/sdk` is fetch-based and Standard-Webhooks verification is WebCrypto-compatible, so this is viable; or (b) a separate tiny worker. Lean (a): one deployable, behind the existing rate-limit/idempotency plumbing; the earlier "Worker imports nothing Polar" rule is amended to "Polar code in the Worker is confined to the webhook + checkout routes and `applyPolarState`" (the import-graph guard can enforce the confinement by directory rather than banning the package).
- **Checkout/portal:** plain Polar-hosted checkout links + portal sessions minted via SDK from the Worker — no plugin UI conveniences were load-bearing anyway.
- **S2 spike:** question 5 (plugin outside Next.js) is dropped; add instead: verify `@polar-sh/sdk` webhook signature verification runs under `workerd` (miniflare test), and verify external-customer-id checkout linkage end-to-end. Questions 1–4 and 6 stand unchanged.
