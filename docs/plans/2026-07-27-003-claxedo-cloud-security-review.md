# Claxedo Cloud: pre-launch security review

- **Date:** 2026-07-27
- **Status:** REVIEW COMPLETE — findings only, nothing fixed by this pass
- **Scope:** authorized defensive source review of the owner's own product, ahead of a public free-tier launch. Read-only, local. No live system was probed.
- **Method:** six dimension reviewers (identity/authN, tenant isolation, secrets/credentials, abuse/billing, web/edge, code-execution/supply-chain), each adversarially refuted by a second reviewer instructed to default to REFUTED, then a cross-cutting synthesis for attack chains. Three dimensions returned placeholder stubs on the first attempt and were re-run; results below are from the real runs. Every claim marked CONFIRMED was re-verified by hand against the cited file before being written here.

---

## 1. Verdict

**Fundamentally sound, with one critical bug that must not ship.**

Across all six dimensions the verified-safe list substantially outnumbers the findings, and the core primitives are done right: webhook signature verification is timing-safe over the raw body before parsing; JWT verification pins algorithms and checks issuer, audience, and expiry; credential encryption is proper AEAD with per-org key derivation and unique IVs; entitlement checks fail closed with real defense-in-depth; CORS is an anchored allowlist. This is not a codebase with systemic security debt.

But one function lets **anyone, with no account at all, cancel a paying customer's subscription.** Fix the five items in §3 and this is a defensible public launch.

A second, structural point matters more than any individual bug — see §5.

---

## 2. The critical finding

### `applyClerkWebhook` is unauthenticated and can cancel any org's subscription

`convex/orgs.ts:239` is the **only** `publicMutation` in the entire Convex codebase — verified: `grep -rn "publicMutation\|publicQuery" convex/*.ts` outside `model.ts` returns exactly one hit.

This is not an oversight. The code says so at `convex/orgs.ts:232-237`:

> "PUBLIC ON PURPOSE-shaped hole with a known ceiling: as a public mutation it is also directly callable by any Convex client without authentication, which pre-dates D8 and is preserved byte-identical here. Closing it (internal mutation, or a service-token arg threaded from the http action) is a flagged follow-up, not a D8 change."

Someone found this, wrote it down, and deferred it. The deferral is no longer acceptable, because the product is about to charge money.

**Attack path.** The handler dispatches on a caller-supplied `type` string and `data` blob with no verification. An attacker calls `orgs:applyClerkWebhook` directly against the Convex deployment with `type: "organization.deleted"` and the victim's Clerk org id. The handler soft-deletes the org. `convex/billing.ts:236` treats `deleted_at` as authoritative for entitlement, so the victim's paid access dies. Variants with `organizationMembership.*` forge or strip memberships, producing a fake seat-cap lockout.

**The assumed mitigation is false.** The defence was "the Convex URL isn't in the browser bundle." It is: `packages/claxedo-app/src/app/entry/index.tsx:86` reads `import.meta.env.VITE_CONVEX_URL`, and Vite inlines `VITE_`-prefixed vars into the built bundle by design — that is the entire purpose of the prefix. The URL ships in cleartext to every visitor, and the `convex` client is a public npm package. There is no obscurity barrier, and no account is required.

Note the HTTP handler in front of it is correct: `convex/http.ts:36-41` returns 503 with no verifier configured and 401 on a failed svix check. The problem is that the mutation is reachable *without going through it*.

**Fix.** Make it an `internalMutation`, called from `convex/http.ts` via `internal.orgs.applyClerkWebhook`. Small and mechanical.

---

## 3. Must fix before public launch

All five are small, same-shape fixes — realistically under a day of engineering plus tests.

| # | Where | What | Severity |
|---|---|---|---|
| 1 | `convex/orgs.ts:239` | `applyClerkWebhook` → `internalMutation`, called via `internal.` from `http.ts`. See §2. | **critical** |
| 2 | `convex/workspaces.ts:242` | `createCloud` — add the existing-row guard. | **high** |
| 3 | `packages/claxedo-server/src/routes/hosted-workspace.ts` `/create` | Add `controlPlaneRateLimitError` + a per-org cap on live leases. | **high** |
| 4 | `convex/agentExtensionPolicies.ts:105` | For `scope==="org"`, require a real `org_memberships` row, not just workspace-admin. | **medium** |
| 5 | `convex/auditEvents.ts:4` | Add `authorizeWorkspace(ctx, workspace, "read")` before tagging an entry. | **low** (cheap; do it with the others) |

### #2 in detail — `createCloud` workspace-id collision

`convex/workspaces.ts:262` does an unconditional `ctx.db.insert("workspaces", { workspace_id: args.workspace_id, ... })` on a **client-supplied** id. Its sibling `registerLocalForSharing` at `convex/workspaces.ts:382` has exactly the guard it lacks:

```ts
const existing = await workspaceByPublicId(ctx.db, args.workspace_id)
if (existing) {
  if (!(await authorizeWorkspace(ctx, existing, "admin"))) throw new Error("Workspace not found")
```

Insert a duplicate and every `workspaceByPublicId(...).unique()` lookup for that id throws — sessions, shares, extensions, runtime tokens, local-host links all break. The victim's workspace is permanently bricked until an operator deletes the row by hand.

**Compounding it:** ids are generated as `` `ws_${Date.now().toString(36)}` `` (`routes/workspace.ts:392`, `routes/hosted-workspace.ts:308`) — a bare millisecond timestamp with **no random component**, so they are enumerable, not just leakable. Any former collaborator also retains the id forever, since `workspaceShares.revoke` never rotates it.

Verified benign: this is denial-of-service only, not escalation. `convex/runtimeAccessTokens.ts:active` re-runs the same `.unique()` at validation time, so a collision makes relay token validation **throw** rather than misroute to the wrong tenant. It fails closed.

---

## 4. Should fix soon after launch

6. **`opencode-compat-context.ts` `workspacePath()`** — accepts absolute paths and `..` verbatim, no containment. Apply the discipline `repository-file-authority.ts` already has (reject absolute/`..`, realpath + `insideRepository`). **Not reachable from the hosted Worker** (see §6), so it does not block a Cloud-only launch — but it must land before self-host or user-hosted-workspace GA.

7. **Rate limiters are per-isolate in-memory.** `control-plane/rate-limit.ts:36` is a module-level `Map`. On Cloudflare's multi-isolate deployment the ceilings do not hold globally. Move to a Durable Object or Cloudflare's native Rate Limiting binding. This also weakens the unauthenticated device-auth endpoints.

8. **No security headers anywhere** — no CSP/`frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy`, or HSTS on the app, the marketing site, or the Worker's own responses.

9. **CLI session tokens cannot be revoked.** `control-plane/cli-session-token.ts` mints bare stateless JWTs with no `jti` registry — unlike Runtime Access Tokens, which have a full registry with `revoke`/`revokeForWorkspaceUser` in `convex/runtimeAccessTokens.ts`. A leaked CLI refresh token stays valid until natural expiry (default 90 days; the accepted upper bound is **10 years**) with no "sign out everywhere" and no kill switch short of rotating the signing key for every user at once. Add a `jti` registry mirroring the RAT one, and tighten the max TTL.

10. **KEK rotation never re-encrypts.** `credentials/envelope.ts:246-274` accepts decryption under any known key id and never rewrites under the current key; no rewrap job exists anywhere. So after rotating a compromised KEK, any credential the user never touches again stays encrypted under the **compromised** key indefinitely — while removing `KEK_NEXT` to retire it makes those credentials permanently undecryptable. Add opportunistic rewrap on `get()` when the resolved key id isn't current.

11. **`audit_events` is write-only.** No `list`/`query` function exists anywhere in `convex/`. Combined with #5 above (any user can write an entry against any workspace), there is currently **no usable incident-response trail** — which matters precisely for investigating the class of bug this review found.

12. **No cascading data erasure.** `convex/orgs.ts:252` handles `organization.deleted` by flipping `deleted_at` and nothing else. Workspaces, sessions, messages, connections, and encrypted provider credentials in KV all persist indefinitely. The only real purge logic in the repo is `convex/workgraphOwnerDeletion.ts`, scoped to WorkGraph and not wired to this path. Worth a deliberate decision before onboarding EU/CA users at any scale.

13. **`bun audit`: 5 critical, 59 high, 106 moderate, 22 low across 40 packages.** The criticals are in `fast-xml-parser`, `seroval`, `shell-quote`, `tar`, and `vitest`. Partial triage done: `vitest` is dev-only; `shell-quote` is a runtime dep of claxedo-app but only its `parse` export is used, not the vulnerable `quote()`. The other three were **not** traced to a runtime path — do that with `bun why` before launch rather than assuming they are build-only.

14. **One non-constant-time secret compare.** `channels-control-plane.ts:611-614` uses plain `===` on the channel admin bearer, and `routes/credential.ts:107-114` does the same for `CLAXEDO_CREDENTIALS_TOKEN`. Every other bearer check in the codebase uses `timingSafeEqualStrings`. Low exploitability over a network, but it is an inconsistency worth closing.

---

## 5. The structural lesson (more important than any single bug)

Three reviewers, working independently on different dimensions, each found one bug of the **same shape**: an exported Convex function that assumes `claxedo-server`'s HTTP proxy is the security boundary.

It isn't. **The Convex function is the boundary.** The deployment URL ships in every page load, the client library is public on npm, and `convex/auth.config.ts` uses the standard Clerk JWT template — so any signed-up user can mint a valid token and call any exported function by name.

`convex/model.ts` already encodes this correctly: the mandatory builder pattern makes "forgot to check identity" an explicit, reviewed exception rather than a default, and an architecture guard test ratchets raw `queryGeneric`/`mutationGeneric` usage to zero. The discipline exists. What's missing is a check for the *next* layer of the same mistake — a function that authenticates correctly but forgets a dedup or authorization guard its siblings have.

**Extend the existing architecture-guard test** to flag: (a) any `publicMutation`/`publicQuery` without an inline justification tied to a verified caller, and (b) any `authedMutation` that inserts a row keyed on a client-supplied unique-ish field without a preceding lookup on that field. Patching the three functions closes the instances; only a guard closes the class.

---

## 6. Hosted vs self-host: a severity split that matters

The code-execution review traced imports concretely rather than reasoning from filenames, and the result substantially **de-escalates** the exec surface for Claxedo Cloud specifically.

**Every subprocess-spawning path in the repo is wired only into `server.ts`, never into `worker.ts`/`hosted-app.ts`** — `opencode-compat-git.ts`, `workspace-git.ts`, `local-execution.ts`, `workspace-store.ts`, `credentials/sync.ts`, `server-workspace-pty-proxy.ts`, and the docker/box/modal/vercel sandbox drivers. Cloudflare Workers cannot spawn processes at all, so this is architecturally enforced. In the hosted product, tenant code runs entirely inside a remote sandbox; the Worker never executes tenant commands.

Two findings are therefore **self-host-only, not Cloud-blocking** — but both are live code a customer can turn on today:

- **Command injection via `startCommand`.** `routes/opencode-compat-worktree-routes.ts:25,39,142` takes `startCommand` from a JSON body and passes it to `shell()`, which is `execFile("bash", ["-lc", cmd])` (`opencode-compat-git.ts:105-107`). Arbitrary command execution as the server user. Verified not in the Worker: `grep -c "OpenCodeCompatRoutes"` → `server.ts: 2`, `hosted-app.ts: 0`.
- **Self-host multi-org shares one unscoped credential table.** `storage/provider-credential.sql.ts` — verified, the table has `provider_id`, `account_id`, `status` and **no org or tenant column**. `credentials/registry.ts` resolves by `provider_id` alone. In `server.ts`'s signed multi-org mode the gate is only `auth.mode !== "signed"`, so any signed-in user from any org can list, overwrite, delete, or force-verify another org's provider credentials. The hosted Worker path (`worker-credentials.ts`, per-org HKDF subkeys, org-prefixed KV keys, orgId from a verified JWT claim only) is correctly isolated and unaffected.

One genuinely hosted-reachable gap: **the `exe` sandbox driver cannot enforce host-based egress policy at all** (`packages/sandbox-manager/src/drivers/exe.ts:189-193` throws unless mode is `allow-all`), unlike the Cloudflare and Daytona drivers which implement a real JWT-scoped egress broker. Only matters if `CLAXEDO_SANDBOX_DRIVER=exe` is selected in production.

---

## 7. Verified safe (recorded so the review is trustworthy)

- **Webhook integrity.** Polar: `billing/standard-webhooks.ts:49-54`, timing-safe HMAC over the raw body with a ±5min window, called before `JSON.parse`. Clerk: svix verification in `convex/http.ts:36-41`, fails closed at 503/401.
- **JWT verification.** Explicit `algorithms: ["ES256","EdDSA","RS256"]` allowlist in `control-plane/auth.ts:306-312` and the relay's verifier — no `alg:none`, no HS/RS confusion. Issuer, audience, and expiry checked on every path; `jose`'s 0s clock tolerance never overridden. Deliberate audience separation between token kinds so a leaked token from one flow can't be replayed against another.
- **Fail-closed on absent secrets.** Explicitly checked the classic empty-string-bypass case: `internal-admin-auth.ts:3-9` does `if (!secret || !header) return false` — an absent env var never falls through to comparing empty against empty. Same in `convex/model.ts:351-354`.
- **Credential encryption.** AES-256-GCM with a fresh 12-byte IV per write, AAD binding ciphertext to `<key-id>:<credential-id>` so blobs can't be relocated, per-org HKDF-SHA-256 subkeys, fail-closed on missing/malformed KEK, no plaintext fallback. Secrets never echoed in API responses (`routes/credential.ts:50-70` redacts to `has_secret`). No committed KEK values.
- **Entitlement defence-in-depth.** `workspace-hosted-connection-info.ts` re-runs `requireCloudWorkspaceEntitlement` at every connect/wake, independent of the `/create` gate. **This is why the `createCloud` and rate-limiter gaps cannot be chained into free infrastructure spend** — only into row pollution and DoS.
- **CORS, cookies, CSRF.** Anchored allowlist, no Origin reflection, no credentialed wildcard. No cookies are set anywhere, so there is no ambient-auth CSRF surface.
- **Egress secret brokering.** `drivers/cloudflare-egress.ts:119-171` — per-sandbox expiring JWT, host allowlist checked before credential injection, injected header stripped from the response. Brokered secrets never enter the sandbox environment. Control-plane secrets verified absent from all driver envs.
- **Desktop auto-updater.** Standard `electron-updater`, GitHub Releases provider, `hardenedRuntime: true` + `notarize: true`, `autoDownload: false`, and no `verifyUpdateCodeSignature: false` override anywhere.
- **Relay DoS controls.** Per-host reconnect cap (429), per-tunnel in-flight request cap (429), backpressure-based socket close.
- **Supply chain hygiene.** All 15 files in `/patches` are narrow bugfixes with no network or credential handling. The one postinstall (`packages/core/script/fix-node-pty.ts`) only `chmod`s a vendored binary.
- **`hosted-shell.ts` is not an exec surface.** Verified twice by hand: zero `child_process`/`spawn`/`execFile` matches. "Shell" means the app-shell *frontend*. An earlier reviewer flagged it from the filename alone; that finding was retracted.

---

## 8. Caveats on this review

- It is a **source review**. Nothing was tested against a running system, so anything depending on deployed configuration is unverified — notably whether `CLERK_JWT_AUDIENCE` is actually set on the hosted Worker (`control-plane/auth.ts:296` makes the audience check conditional on it being present) and whether `CLAXEDO_SANDBOX_DRIVER` selects the `exe` driver.
- **`git clone` inside the sandbox was not audited** — the bootstrap consuming `WORKSPACE_RUNTIME_GIT_REPO_URL` lives outside this repo. A tenant-supplied `repoUrl` beginning with `-` is a known git argument-injection vector if that script interpolates rather than using argv arrays. Audit it wherever it lives.
- The three re-run dimensions had no adversarial verification pass (the first-attempt stubs consumed it), so identity, secrets, and code-exec findings carry slightly lower confidence than the tenant-isolation, abuse, and web-edge ones. Their highest-consequence claims were hand-verified instead.
- No penetration testing, no dependency-path tracing to completion, no review of CI signing-key custody.
