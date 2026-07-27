# Claxedo Cloud: pre-launch security review

- **Date:** 2026-07-27 (round 1) · **Re-verified:** 2026-07-27 (round 2, at `0bcf5c422`)
- **Status:** ROUND 2 COMPLETE — **1 of 5 must-fix items is closed; 4 remain open**
- **Scope:** authorized defensive source review of the owner's own product, ahead of a public free-tier launch. Read-only, local. No live system was probed.
- **Method:** round 1 ran six dimension reviewers with adversarial refutation. Round 2 re-verified every round-1 finding against current `dev`, audited the four security commits that landed since, and ran the adversarial passes round 1 never got (identity, secrets, code-execution). Six independent verifiers plus a synthesis; every headline claim below was also hand-checked by the orchestrator.

---

## 1. Scoreboard

**The belief that the reported bugs are fixed is incorrect.** One landed. Four did not.

| # | Item | Status |
|---|---|---|
| 1 | `applyClerkWebhook` unauthenticated org takeover | ✅ **FIXED** — and regression-pinned |
| 2 | `createCloud` client-supplied `workspace_id`, no guard | ❌ **OPEN** (high) |
| 3 | `POST /create` no rate limiter, no per-org lease cap | ❌ **OPEN** (high) |
| 4 | `agentExtensionPolicies.set(scope="org")` privilege escalation | ❌ **OPEN** (high) |
| 5 | `auditEvents.record` arbitrary `workspace_id` | ❌ **OPEN** (medium) |

All **seven** "should fix soon" items from round 1 are also still open. Files `convex/workspaces.ts`, `hosted-workspace.ts`, `agentExtensionPolicies.ts`, and `auditEvents.ts` show no security-motivated commits since round 1 — items #2–#5 are byte-identical in shape to how round 1 described them.

**Three separate items did get fixed that round 1 never asked for** — see §3. That matters, and it's the good news here.

---

## 2. What genuinely got fixed

### #1 — `applyClerkWebhook` is properly closed

`convex/orgs.ts:246` now uses `webhookMutation`, and `convex/model.ts:430-434` defines that as a thin wrapper over `internalMutationGeneric` — a real Convex internal function, excluded from the client-callable `api` surface. Verified by hand, not inferred from the name.

The one legitimate caller still works: `ctx.runMutation` in `convex/http.ts` resolves by UDF path regardless of visibility, and the svix signature check is unchanged.

**It is also regression-pinned**, which is better than the fix itself. `convex-authz-guard.test.ts:61` sets `PUBLIC_BUILDER_BASELINE: string[] = []` and `:173` asserts `applyClerkWebhook.isInternal === true`. Any future re-introduction of a public builder anywhere in `convex/` fails CI. Commit `58991b20d` also removed a wildcard localhost CORS grant as secondary hardening.

**Do not relitigate this one.** No bypass found.

### Round 1 understated this finding's impact

Round 1 described the consequence as subscription cancellation. The fix commit's own comment reveals worse: `organizationMembership.created` let a caller **mint themselves an `org:admin` membership in an arbitrary org**, which `directOrgRole` then resolves to admin on *every workspace in that org*. That is full org takeover, not just billing disruption. Recorded here because the severity was right but the reasoning was thinner than the bug deserved.

---

## 3. The other fixes that landed (none were on round 1's list)

All four verified genuine and non-bypassable:

- **`d394a5544`** — stopped projecting control-plane secrets into agent-driven child environments. A real secret-leak class **round 1 missed entirely**. Correctly scoped, though one verifier flagged adjacent paths worth a second look.
- **`9bb7c30d0`** — desktop main-window RCE via link click. Checked for the same weakness in other webview/`BrowserWindow` surfaces; none found.
- **`ac202754c`** — gated the ungated control-plane provider-auth router. This also incidentally fixed round 1's finding about `routes/credential.ts` comparing a bearer with plain `===`.

**Read this as a positive signal.** Someone is independently hunting and closing real, serious vulnerabilities beyond the formal review — including a secret-leak class the review didn't catch. The gap isn't capability; it's that the written punch list hasn't been worked as a checklist. That's a tracking problem, not a security-culture problem.

---

## 4. Corrected must-fix list

Ordered. Items 1 and 2 are the priority: **both are reachable directly through the public Convex SDK by any signed-up free user**, independent of which HTTP frontend is deployed.

### 1. `convex/workspaces.ts:242` `createCloud` — no existing-row guard (high)

Handler goes straight to `ctx.db.insert("workspaces", { workspace_id: args.workspace_id, ... })` with no lookup. The sibling `registerLocalForSharing` in the same file has exactly the guard this lacks.

**New in round 2 — this is worse than round 1 said.** `createCloud` is an `authedMutation`, so it is callable *directly via the public Convex SDK* using `VITE_CONVEX_URL` from the app bundle. That **bypasses the Worker route entirely**. Hardening `/create` would not close it.

> **The fix must land in the Convex mutation itself, not the Worker route.** Anything else leaves the SDK path open.

```ts
const existing = await workspaceByPublicId(ctx.db, args.workspace_id)
if (existing) throw new Error("workspace_id already exists")
```

### 2. `convex/agentExtensionPolicies.ts:113` `set(scope="org")` — privilege escalation (high)

The only check is `authorizeWorkspace(ctx, workspace, "admin")`, applied identically for all three scopes. For `scope==="org"`, `scopedPatch` writes a row keyed on `workspace.org_id`, which `policyRows` then reads for **every workspace in that org**.

Round 2 traced the full escalation chain rather than just the handler:
1. A workspace owner runs `workspaceShares.grant({ role: "admin", granted_to_clerk_subject: <outsider> })` — a legitimate, narrow, single-workspace share. `grantedUser` requires **no** org membership.
2. That outsider now passes `authorizeWorkspace(workspace, "admin")` via the `share` precedence slot — `shareRole` (`model.ts:174-181`) reads `workspace_share_grants` with no `org_memberships` check anywhere.
3. They call `set({ scope: "org", ... })`.
4. The write lands org-wide, changing policy for workspaces they were never granted.

Fix is scoped to this one file — require an `org_memberships` row when `scope === "org"`. **Do not redesign the sharing model**; external single-workspace collaboration is intentional and correct.

### 3. `hosted-workspace.ts` `POST /create` — no rate limiter, no cap (high)

Every sibling mutating route in the same file calls `controlPlaneRateLimitError` (lines 181, 227, 373, 408, 479). The one route that provisions real infrastructure via `sandboxManager.ensure` does not. No per-org lease cap exists anywhere — `leaseCap`/`maxLeases`/`MAX_LEASE` return zero hits across claxedo-server, sandbox-manager, and convex.

`requireCloudWorkspaceEntitlement` gates paid-vs-free as a binary capability; it does not throttle rate or concurrent count.

### 4. `convex/auditEvents.ts:4` `record` — arbitrary `workspace_id` (medium)

No `authorizeWorkspace` call in the file. Any authenticated user can attribute fabricated audit rows — with free-form `metadata: v.any()` — to another tenant's workspace.

Practical severity stays moderate *only because* no read/list function over `audit_events` exists yet. Ship any audit UI or compliance export on top of this table and it silently inherits forged data.

```ts
if (workspace && !(await authorizeWorkspace(ctx, workspace, "read"))) throw new Error("Workspace not found")
```

---

## 5. Attack chains among the open items

**Chain A — enumerable ids + no guard + no throttle.** Workspace ids are still `` `ws_${Date.now().toString(36)}` `` (`hosted-workspace.ts:308`, `workspace.ts:392`) — a bare millisecond timestamp, **no random component**, in both server variants. An attacker guesses a victim's id within a plausible creation window, then either collides via `createCloud` to brick that specific workspace, or loops the unthrottled `/create` for unbounded provisioning cost. Fixing #3 alone doesn't stop it, because #1's Convex-SDK path bypasses the Worker limiter entirely.

**Chain B — share grant + no org check + org-scope write.** Detailed in §4.2. None of the three components is a bug alone; the vulnerability is precisely that `set` treats workspace-admin as proof of org authority.

---

## 6. Still open from round 1's "should fix soon" (all seven)

Re-verified as unfixed:

6. `opencode-compat-context.ts` `workspacePath()` — no path containment. Still **not** reachable from the hosted Worker (re-derived independently in round 2), so still not Cloud-blocking.
7. Rate limiters are per-isolate in-memory `Map`s — ceilings don't hold across Cloudflare isolates.
8. No CSP / `X-Frame-Options` / `X-Content-Type-Options` / `Referrer-Policy` / HSTS anywhere.
9. CLI session tokens have no `jti` registry and no revocation path. Default TTL 90 days; accepted upper bound **10 years**.
10. KEK rotation never re-encrypts — a retired-but-configured key decrypts indefinitely.
11. `audit_events` is write-only; no query function exists anywhere.
12. `organization.deleted` only flips `deleted_at` — no cascading purge of workspaces, sessions, messages, or stored credentials.

Plus, from the round-2 adversarial passes:

13. **Self-host multi-org credential isolation (high).** Round 2 specifically checked whether signed multi-org mode is a dead path. **It is real and reachable** — `provider-credential.sql.ts` still has no org column, and any signed-in user from any org can list, overwrite, delete, or force-verify another org's provider credentials. Self-host only; the hosted Worker path is correctly isolated per-org.
14. **Sandbox egress is a broader gap than round 1 described (high).** Round 1 said the `exe` driver can't enforce host-based policy. Round 2 found **no driver is ever given a restricted network policy on the hosted Worker path at all** — the egress broker exists but nothing hands it a restricted allowlist.
15. **Agent-extension materialization (medium)** — confirmed: no signing, no integrity verification, and the "allowlist" is just *is it github.com*.
16. **Dependency advisories (medium)** — `bun audit` reproduces round 1's counts. Round 2 traced reachability for the five criticals, which round 1 could not finish.

---

## 7. Verified safe (re-confirmed in round 2)

Round 2 re-checked round 1's SAFE claims rather than assuming them:

- **JWT algorithm pinning** — explicit allowlist; no `alg:none`, no HS/RS confusion.
- **Absent/empty shared secrets fail CLOSED** — including the classic empty-string-vs-absent-header bypass in `internal-admin-auth.ts`.
- **Runtime access token replay/revocation** via the Convex `jti` registry genuinely works.
- **`opencode-compat-worktree-routes.ts` command injection is real but Worker-unreachable** — re-derived independently from what `worker.ts`/`hosted-app.ts` actually import. Self-host only.
- **Convex builder discipline holds** — zero `publicMutation`/`publicQuery` outside `model.ts`, zero raw `mutationGeneric`/`queryGeneric` escapes, now CI-enforced at an empty baseline.
- Webhook signature verification (Polar HMAC, Clerk svix) timing-safe over the raw body pre-parse; entitlement fail-closed with defence-in-depth at connect time; anchored CORS allowlist; no cookies anywhere; `electron-updater` with notarization.

One cosmetic note: `convex/model.ts`'s `timingSafeEqual` loop length differs from the server-side implementation. Not exploitable — worth normalizing.

---

## 8. Recommendation

Treat this document as a **literal, uncompleted punch list**. Assign owners to the four items in §4 specifically; ambient discovery has not reached those files in the eight commits since round 1.

Items §4.1 and §4.2 gate a public free-tier launch — both are reachable today by any signed-up user through the public Convex SDK, independent of Worker-side hardening.

**Caveats on this round:** still a source review; nothing was tested against a running system. Deployed configuration remains unverified — notably whether `CLERK_JWT_AUDIENCE` is set on the hosted Worker (the audience check is skipped when unset) and which `CLAXEDO_SANDBOX_DRIVER` production selects. The sandbox's own `git clone` bootstrap lives outside this repo and remains unaudited.
