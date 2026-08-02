export const claxedoRepositoryUrl = "https://github.com/kyashrathore/Claxedo"

export const cloudflareDeploymentPrompt = `Deploy the Claxedo hosted control plane to my Cloudflare account.

Start by getting the repository, then work from that checkout:

  git clone https://github.com/kyashrathore/Claxedo.git
  cd Claxedo
  bun install

Run bun install at the repository root before any Wrangler command, then always invoke Wrangler as "bunx wrangler", which prefers a workspace pin when one exists. Do NOT use "npx wrangler" — it ignores the workspace and always fetches an unpinned version. Several checked-in comments still say "npx wrangler"; they are stale, prefer bunx.

All three deploy-unit packages — packages/workspace-relay, packages/claxedo-server and packages/claxedo-app — declare wrangler as a devDependency pinned 4.114.0, so running "bunx wrangler" from inside a package directory gets that exact version and Units 2, 3 and 4 are version-reproducible. This only holds because "bunx" resolves the pin of the package it runs in; run it from the repository root instead and you get an unpinned download. Always cd into the unit's package directory first, then confirm with "bunx wrangler --version" and tell me what you actually got before deploying.

One deliberate exception, so do not "fix" it: the sandbox container worker under packages/claxedo-server/scripts/sandbox/cloudflare-worker stays on wrangler 4.50.0, and .github/workflows/deploy-cloudflare-sandbox-worker.yml pins it inline as "npx --yes wrangler@4.50.0". Its @cloudflare/sandbox SDK is several minors behind and the only honest way to verify that unit is a real multi-gigabyte container image push, so it is frozen to move as one supervised change. It is not part of the four-unit release above.

READ THIS BEFORE TOUCHING CLOUDFLARE — two non-Cloudflare services are mandatory.

1. CONVEX. The Worker reads its workspace authority from CLAXEDO_WORKSPACE_AUTHORITY_URL and that is the only accepted name (CONVEX_URL and VITE_CONVEX_URL are retired aliases and are ignored). If it is missing, composition throws hosted_dependency_missing and the Worker answers 503 on every single request. There is no degraded mode. I must have a Convex deployment and a CONVEX_DEPLOY_KEY before the Cloudflare work begins.

2. CLERK. The Worker requires CLERK_JWT_ISSUER (alias CLERK_ISSUER_URL) and CLERK_JWKS_URL. Missing either one throws hosted_auth_disabled at composition and the Worker answers 503 on every request. CLERK_JWT_AUDIENCE is optional. CLERK_SECRET_KEY is needed only by the smoke scripts. CLERK_WEBHOOK_SECRET is a Svix signing secret set on Convex (bunx convex env set CLERK_WEBHOOK_SECRET) for the identity mirror at POST /api/clerk/webhook in convex/http.ts.

If I cannot supply working Convex and Clerk configuration, stop and tell me — do not start deploying Workers.

THIS BUTTON SERVES THE HOSTED PATH ONLY. packages/claxedo-server/wrangler.toml hardcodes CLAXEDO_DEPLOYMENT_MODE = "hosted" and CLAXEDO_SIGNED_CLOUD_AUTH = "1" in [vars]. An absent deployment mode means self-host by design, and the hosted app refuses to start in that state (hosted_deployment_mode_required). A Convex-free and Clerk-free self-host is a genuinely different deployment shape that this prompt does not cover; say so rather than improvising a hybrid.

THE RELEASE IS FOUR ORDERED UNITS. Deploy most-backward-compatible first, and never reorder them.

Unit 1 — Convex schema, from convex/ at the repository root. Push-only: there is no server-side rollback, so schema changes must be additive and old Workers must keep working against new Convex.
  bunx convex deploy --dry-run --typecheck enable
  bunx convex deploy --typecheck enable --message "<sha>"
  bunx convex env set CLERK_WEBHOOK_SECRET "<svix secret>"

Unit 2 — the workspace relay Worker, from packages/workspace-relay using wrangler.toml ONLY.
  bunx wrangler deploy --env staging --var "CLAXEDO_RELEASE:<sha>"
Never deploy wrangler-h2.toml — it is a named tear-down experiment (claxedo-workspace-relay-h2-reeval) from a relay re-evaluation, not a production shape. Never treat fly.toml as part of this path either; that is the non-Cloudflare regional-container shape.

Unit 3 — the control-plane Worker, from packages/claxedo-server.
  bunx wrangler deploy --env staging --var "CLAXEDO_RELEASE:<sha>" --var "CLAXEDO_PUBLIC_URL:<worker url>" --var "CLAXEDO_WORKSPACE_RELAY_URL:<relay url>" --var "CLAXEDO_SANDBOX_BUILD_ID:<build id>"

Unit 4 — the web app on Cloudflare Pages, from packages/claxedo-app, built against the already-verified control plane.
  bun run --cwd packages/claxedo-app build
  bunx wrangler pages deploy dist --project-name "<pages project>" --branch "<pages branch>"
Build-time variables: VITE_CLAXEDO_SERVER_URL, VITE_AUTH_ENABLED=true, VITE_CLERK_PUBLISHABLE_KEY, VITE_CONVEX_URL.

CONFIGURATION AS IT ACTUALLY APPEARS IN THE REPOSITORY. Read the files rather than trusting this list, and tell me about any difference you find.

packages/claxedo-server/wrangler.toml — worker name claxedo-control-plane, staging name claxedo-control-plane-staging, main src/worker.ts, compatibility_date "2025-05-01", compatibility_flags ["nodejs_compat", "global_fetch_strictly_public"]. nodejs_compat is required for Worker-compatible npm SDKs and is what populates process.env from text bindings and secrets.
  Durable Object bindings: WORKGRAPH_SETTLER to class WorkGraphSettler; WAKE_LANE to class ClaxedoWakeLane; LIVE_SYNC_ROOM to class LiveSyncRoom. All three are declared twice, once at the top level and once under [[env.staging.durable_objects.bindings]], because environments do NOT inherit DO bindings. Migrations (tags v1, v2, v3, all new_sqlite_classes) are declared top-level ONLY and ARE inherited.
  R2 binding CLAXEDO_DOCUMENTS to bucket claxedo-documents at the top level and to bucket claxedo-documents-staging under [[env.staging.r2_buckets]].
  Cron triggers "* * * * *" and "*/15 * * * *", each declared twice — [triggers] and [env.staging.triggers] — because Cron Triggers are not inherited by environments either. The every-minute cron drives WorkGraph settlement; the 15-minute cron drives sandbox GC and the bounded WorkGraph reconciler.

packages/workspace-relay/wrangler.toml — worker name claxedo-workspace-relay, staging name claxedo-workspace-relay-staging, main src/worker.ts, compatibility_date "2025-05-01". Note there are NO compatibility_flags on the relay; do not copy the control plane's flags across. Durable Object binding WORKSPACE_RELAY_ROOM to class WorkspaceRelayRoom, migration tag v1, mirrored under [[env.staging.durable_objects.bindings]].

WORKER SECRETS, set with "bunx wrangler secret put <NAME> --env staging". The control plane fail-closes at composition on each of these, in this order: CLAXEDO_WORKSPACE_AUTHORITY_URL, CLAXEDO_WORKSPACE_RELAY_URL, CLAXEDO_RELAY_RESOLVER_TOKEN, CLAXEDO_RUNTIME_ADMIN_TOKEN (which must NOT equal the resolver token, or it throws hosted_token_reuse), and CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM. CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN is required once a sandbox driver is configured. There is no Sentry integration anywhere in this repository — do not set a Sentry DSN or invent one. Telemetry is PostHog only and stays off by default: CLAXEDO_POSTHOG_KEY and CLAXEDO_POSTHOG_HOST are optional and telemetry no-ops cleanly when absent, and even a configured key sends nothing unless CLAXEDO_TELEMETRY_MODE is also set to "on".
  One trap worth checking explicitly: only the PRIVATE key is checked at boot, so a deploy that sets CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM but not CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM boots green and then serves 503 jwks_no_keys_configured from the JWKS endpoint. Set both.
  Relay secrets: CLAXEDO_RELAY_RESOLVER_TOKEN, CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM, CLAXEDO_CONTROL_PLANE_JWKS_URL.

TWO PREREQUISITES THAT NO WORKFLOW CREATES FOR YOU.
  R2 buckets must exist BEFORE the control-plane Worker deploy — the deploy binds them, it does not create them. Use "bunx wrangler r2 bucket create claxedo-documents-staging" (and claxedo-documents for production), then verify with "bunx wrangler r2 bucket info <bucket> --json". A missing binding surfaces later as 503 document_backend_unavailable.
  The sandbox image must be built before the Worker deploy, because that deploy passes CLAXEDO_SANDBOX_BUILD_ID as a --var. The claxedo-sandbox-image workflow emits that content build id (alongside CLAXEDO_SNAPSHOT_NAME and CLAXEDO_SANDBOX_IMAGE) in its job summary; pin the control plane to it.

VERIFY WITH REAL COMMANDS, NOT ASSERTIONS THAT IT WORKED.
  Before deploying anything, run the Worker-safe dry run, which needs no Cloudflare account:
    bun run --cwd packages/claxedo-server check:worker-safe
  It wraps "wrangler deploy --env staging --dry-run --outdir dist-worker" and proves the import graph is Worker-safe.
  After the control-plane Worker is up, run this curl sequence against its base URL and show me the raw output of each:
    curl -fsS "$BASE/api/claxedo/health"            expect .ok == true and mode "hosted-control-plane"
    curl -fsS "$BASE/api/claxedo/mode"              expect .signedAuth == true, plus authority, relay and workgraph true
    curl -fsS "$BASE/api/claxedo/compatibility"     expect .ok == true and every entry in .checks ok
    curl -fsS "$BASE/.well-known/jwks.json"         expect a non-empty .keys array, NOT 503 jwks_no_keys_configured
  Then prove auth fails CLOSED, which liveness checks do not:
    curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer garbage" "$BASE/api/workgraph/snapshot?limit=1"
  That must be exactly 401. A 200 is a launch-blocking misconfiguration — stop and report it.
  Finally, the cross-tenant WorkGraph smoke:
    bun run --cwd packages/claxedo-server smoke:workgraph
  It requires BASE_URL, CLERK_SECRET_KEY, WORKGRAPH_SMOKE_USER_A_ID, WORKGRAPH_SMOKE_USER_B_ID, WORKGRAPH_SMOKE_ORGANIZATION_A_ID, WORKGRAPH_SMOKE_ORGANIZATION_B_ID and WORKGRAPH_SMOKE_RECONCILE_TOKEN. If I cannot supply two distinct Clerk users and organizations, say the cross-tenant isolation is UNVERIFIED rather than skipping it silently.

HOW MUCH TO TRUST THIS PATH. As of 2026-07-27 a staging deployment of exactly this shape exists in the Claxedo origin repository and redeploys continuously from its dev branch, so the sequence above is proven at least once end to end. Production has never been stood up. More importantly, I am deploying into MY OWN Cloudflare, Convex and Clerk accounts, which differ in account limits, enabled features, existing resource names and permissions. Do not assume the origin repository's success transfers. Verify every step against my target, and when observed behavior diverges from what this prompt or the repository claims, STOP and report the divergence instead of working around it.

HOW TO WORK WITH ME.
  Begin read-only. Inspect the wrangler configs, the Worker entrypoint, the deploy workflows in .github/workflows/ and public-docs/deploy-runbook.md, and treat the checked-in implementation as the source of truth over anything written here.
  Explain which components run in Cloudflare and which require a connected relay, workspace runtime, local machine, or sandbox provider. Never imply that terminals, files, processes, or arbitrary coding-agent execution run inside the control-plane Worker; they do not.
  Give me a prerequisite table with four states: already configured, safe to generate, needs a decision from me, needs a secret from me.
  Ask for one missing decision or secret at a time. Never echo, log, commit, or place a secret in a command argument — use "wrangler secret put" over stdin.
  Name any resource that can create a bill before creating it, and wait for my approval.
  Generate signing keys and internal service tokens cryptographically where the repository supports it.
  Deploy every unit from one reviewed git revision.
  Stop if a required path cannot be verified. Describe a partial deployment precisely rather than calling it complete.

Finish with the deployed URLs, the exact git revision, where every component runs, the raw verification output, unresolved or optional integrations, estimated recurring cost, upgrade instructions, and exact rollback and teardown commands. Note in particular that Convex has no rollback (roll forward by redeploying the previous green revision) and that a Worker cannot be rolled back across a Durable Object migration.

Never weaken authentication, expose an unsigned service publicly, invent missing infrastructure, or bypass a failing security check.`
