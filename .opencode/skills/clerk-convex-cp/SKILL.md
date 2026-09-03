---
name: clerk-convex-cp
description: Use this skill when the user wants to deploy the Claxedo control plane (CP) with Convex as the database and Clerk as auth, instead of the default Cloudflare D1 + Better Auth stack. Covers re-adding Convex backend, Clerk auth, CP Worker wiring, and deploy workflows.
---

# Clerk + Convex Control Plane Deploy

Main codebase default is Cloudflare Workers + D1 + Better Auth (`CLAXEDO_ADAPTER_PROFILE=better-auth-d1`).
This skill restores the retained `clerk-convex` profile: Convex as workspace authority store + Clerk as identity, fronted by the hosted control-plane Worker.

No backward compat is kept in main. Use this skill for greenfield clerk-convex installs only.

## 1. Prerequisites

- Clerk application with:
  - Publishable key (`VITE_CLERK_PUBLISHABLE_KEY`, `pk_*`)
  - Secret key (`CLERK_SECRET_KEY`, `sk_*`)
  - JWKS URL (`CLERK_JWKS_URL`, e.g. `https://<instance>.clerk.accounts.dev/.well-known/jwks.json`)
  - JWT issuer (`CLERK_JWT_ISSUER` or `CLERK_JWT_ISSUER_DOMAIN`, e.g. `https://<instance>.clerk.accounts.dev`)
  - Webhook Svix secret (`CLERK_WEBHOOK_SECRET`, from Clerk Dashboard -> Webhooks)
- Convex account + project. `bunx convex dev` once to get `CONVEX_URL` + `CONVEX_DEPLOY_KEY`.
- Cloudflare account for the control-plane Worker (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
- Bun 1.3.x, Wrangler 4.x.

## 2. Re-add dependencies

Root `package.json`:
```json
{
  "dependencies": {
    "convex": "1.42.3",
    "@convex-dev/migrations": "0.3.5",
    "svix": "1.99.1"
  }
}
```

`packages/claxedo-server/package.json`:
```json
{
  "dependencies": { "convex": "1.42.3", "svix": "1.99.1", "jose": "6.2.4" },
  "devDependencies": { "convex-test": "0.0.54" }
}
```

`packages/claxedo-app/package.json`:
```json
{
  "dependencies": { "@clerk/clerk-js": "5.125.10" },
  "devDependencies": { "@clerk/testing": "2.2.7" }
}
```

Then `bun install`.

Reference (pre-removal pins): root `package.json:120,126,129`, `packages/claxedo-server/package.json:127,136,147`, `packages/claxedo-app/package.json:82,116`.

## 3. Restore Convex backend (`convex/`)

Restore the whole `convex/` directory from git history (tag before removal, e.g. `git checkout <tag> -- convex/`). Required files:

- `convex.config.ts` — `defineApp() + app.use(migrations)` (`@convex-dev/migrations` component).
- `auth.config.ts` — Clerk JWT provider:
  ```ts
  export default {
    providers: [{
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN ?? process.env.CLERK_JWT_ISSUER!,
      applicationID: process.env.CLERK_JWT_AUDIENCE ?? "convex",
    }],
  } satisfies AuthConfig
  ```
- `schema.ts` — ~20 tables: `users, orgs, projects, workspaces, sessions, workgraph*, billing, auditEvents, sandboxLeases, hostEnrollments, serviceInstallations, runtimeAccessTokens, wakes`, plus Clerk mirror fields (`clerk_org_id, clerk_subject, clerk_updated_at, clerk_sync_state, clerk_membership_tombstones`, indexes `by_clerk_org_id/by_org_user/by_membership`).
- `http.ts` — `httpRouter` + `POST /api/clerk/webhook` via `svix` `Webhook.verify(CLERK_WEBHOOK_SECRET)` -> `api.orgs.applyClerkWebhook`.
- `model.ts` — authz wrapper (`workspaceRoleForUser`, `orgAdminForUser`, token_identifier resolution).
- `orgs.ts / users.ts / sessions.ts / teams.ts / projects.ts / workspaces.ts` + workgraph/billing/wakes modules.
- `clerkReconcile.ts` (hand-rolled Clerk Backend fetch, paginated `limit/offset`, sweep + pure `reconcileMemberships` diff, tombstone-aware) + `clerkTombstones.ts` + `crons.ts` (6h stale-webhook flag) + `migrations.ts`.
- Delete `_generated/` then regenerate: `bunx convex dev --once`.

Set Convex env: `bunx convex env set CLERK_WEBHOOK_SECRET <svix-secret>` and `CLERK_JWT_ISSUER_DOMAIN`, `CLERK_JWT_AUDIENCE` if non-default.

## 4. Restore server auth + authority wiring

- `packages/claxedo-server-core/src/platform/auth/clerk-adapter.ts`:
  - `signedCloudAuthRequested(env)` gates on `CLAXEDO_SIGNED_CLOUD_AUTH=1/true/yes`.
  - `controlPlaneAuthConfig(env)` requires `CLERK_JWT_ISSUER (+CLERK_JWKS_URL) + authorityConfigured`, optional `CLERK_JWT_AUDIENCE`.
  - `verifyClerkBearer()` via `createClerkTokenVerifier({issuer, jwksUrl, algorithms:[ES256,EdDSA,RS256]})` from `@claxedo/workspace-relay-protocol`.
  - `clerkAuthAdapter({env, verifier, native})` — native port must be `adapter:"clerk"` (`createClerkNativeSessionAuthPort` in `cli-session-token.ts`).
- `packages/claxedo-server/src/authority/adapters/convex/` — `workspace-authority/{api,executor}`, `usage-ledger`, `hosted-sandbox-usage`, `idempotency-store`, `cron-lease`, `connection-attempts`, `service-installation-store`, `user-hosted-relay-target`, `cli-session-tokens`, `timeout`, `retry`, plus `billing/store.ts`, `sandbox/stores/convex.ts`, `hosts/workgraph/convex/*`, `hosts/wakes/convex-wake-store`.
- `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts` + `self-hosted-node/app.ts:93,1415` — mount `clerkAuthAdapter({env, authorityConfigured})`.
- `packages/claxedo-server/src/deployments/hosted-workerd/worker.ts` — compose `createConvexCronLease`, `createConvexIdempotencyStore`, `composeHostedWakes` against Convex URL.
- `CLAXEDO_WORKSPACE_AUTHORITY_URL` (canonical Convex URL) or legacy `CLAXEDO_WORKGRAPH_CONVEX_URL` / `CONVEX_URL`.

## 5. Restore app (browser) auth

- `packages/claxedo-app/src/platform/auth/clerk-browser-auth.ts` — headless `import("@clerk/clerk-js/headless")`, `initializeClerk(deployment)`, `getAuthToken({template:"convex"})`, `useAuth()` (`redirectToSignIn/redirectToSignUp`, `organization()`), exports `browserAuthAdapter = {adapter:"clerk", transport:"bearer"}`.
- `vite.cloud.config.ts` + `vite.browser-auth.ts:21` — `manualChunks: {"vendor-clerk": ["@clerk/clerk-js/headless"]}`.
- Build scripts default to Clerk: `dev/build/serve` use `VITE_CLAXEDO_AUTH_ADAPTER=clerk`. Better-Auth uses `build:better-auth` (`VITE_CLAXEDO_AUTH_ADAPTER=better-auth`, `dist-better-auth`).
- Bake `VITE_CLERK_PUBLISHABLE_KEY` + `VITE_CONVEX_URL` at build time (see `deploy-claxedo-app.yml:28,63-64`).
- E2E: `@clerk/testing/playwright` (`clerkSetup`) in `e2e/playwright/deployed-workgraph.spec.ts`.

## 6. Restore deploy workflows

- `.github/workflows/deploy-convex.yml` — isolated `workflow_dispatch staging|production`: `bunx convex deploy --dry-run --typecheck enable` then `bunx convex deploy --typecheck enable`. Needs env secret `CONVEX_DEPLOY_KEY`. Roll-forward-only.
- `.github/workflows/deploy-control-plane.yml` — canonical CP sequence `Convex -> Worker -> app`. Needs secrets `CONVEX_DEPLOY_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLERK_SECRET_KEY, CLERK_WEBHOOK_SECRET, CLAXEDO_RUNTIME_ADMIN_TOKEN` + vars `CLAXEDO_CONTROL_PLANE_URL, CLAXEDO_WORKSPACE_RELAY_URL, WORKGRAPH_SMOKE_*`. Sets `CLERK_WEBHOOK_SECRET` via `bunx convex env set`.
- `packages/claxedo-server/wrangler.toml` — `name=claxedo-control-plane`, `main=src/deployments/hosted-workerd/worker.ts`, R2 `CLAXEDO_DOCUMENTS`, DOs `WORKGRAPH_SETTLER/WAKE_LANE/LIVE_SYNC_ROOM`, rate limits.

## 7. Env matrix (clerk-convex CP)

| Var | Where | Example |
|---|---|---|
| `CLAXEDO_ADAPTER_PROFILE` | Worker / Node | `clerk-convex` |
| `CLAXEDO_SIGNED_CLOUD_AUTH` | server | `1` |
| `CLERK_JWT_ISSUER` / `CLERK_JWT_ISSUER_DOMAIN` | Convex + server | `https://<instance>.clerk.accounts.dev` |
| `CLERK_JWKS_URL` | server | `.../.well-known/jwks.json` |
| `CLERK_JWT_AUDIENCE` | optional, default `convex` | `convex` |
| `CLERK_SECRET_KEY` | Convex actions + CI smoke only | `sk_*` |
| `CLERK_WEBHOOK_SECRET` | Convex env | Svix `whsec_*` |
| `VITE_CLERK_PUBLISHABLE_KEY` | app build | `pk_*` |
| `VITE_CONVEX_URL` / `CONVEX_URL` | app build / fixtures | `https://<deploy>.convex.cloud` |
| `CONVEX_DEPLOY_KEY` | CI secret per env | `...` |
| `CLAXEDO_WORKSPACE_AUTHORITY_URL` | Worker | Convex URL |

## 8. Deploy sequence

```bash
# 1. Convex
bunx convex deploy --dry-run --typecheck enable
bunx convex deploy --typecheck enable --message "staging <sha>"
bunx convex env set CLERK_WEBHOOK_SECRET <whsec>  # per env
# 2. Worker (control plane)
bun --cwd packages/claxedo-server wrangler deploy --env staging
# 3. App
VITE_CLERK_PUBLISHABLE_KEY=pk_* VITE_CONVEX_URL=https://<deploy>.convex.cloud \
  bun --cwd packages/claxedo-app run build
# 4. Clerk Dashboard -> Webhooks: add ${CONVEX_URL}/api/clerk/webhook (organization + user events)
```

Order matters: Convex first (unrollbackable schema gate rejects narrowing changes over nonconforming rows), then Worker, then app. Same lock `claxedo-cloud-deploy`, `cancel-in-progress: false`.

## 9. Verify

- `bunx convex deploy --dry-run --typecheck enable` green.
- `POST ${CONVEX_URL}/api/clerk/webhook` with bad signature -> 401; with valid Svix signature -> `{ok:true}` and `orgs` patched with `source:"webhook"`.
- Worker `/health` up + fail-closed on garbage bearer.
- App sign-in -> `getAuthToken({template:"convex"})` returns JWT, Convex `ctx.auth` resolves `token_identifier`.
- `bun --cwd packages/claxedo-server run test:convex` (convex-test policy suite, ~400 tests).

## 10. What NOT to bring back

- Do not reintroduce `clerk-convex` into default builds, `better-auth-d1-locked-worker.cf.ts`, or `user-deployed-cloudflare.md`. Those stay Better Auth + D1.
- Do not dual-read/dual-write adapters at request time. Profiles are deploy-time selections (`better-auth-d1` OR `clerk-convex`), never mixed per request (cutover plan R4).
- Keep client bundles clean: `convex` + `@clerk/*` stay forbidden in `app-local`, `desktop`, `local-server`, `host-connector` closures (`script/product-boundary/policies/*`).
