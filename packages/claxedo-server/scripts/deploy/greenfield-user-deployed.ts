import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { STATIC_PRODUCT_DESCRIPTORS } from "../../src/deployments/hosted-shared/deployment-profile"
import {
  betterAuthD1ReleaseInputs,
  betterAuthD1WorkerName,
  renderBetterAuthD1WranglerConfig,
  type BetterAuthD1ReleaseEnvironment,
} from "./release-better-auth-d1"

const serverRoot = path.resolve(import.meta.dirname, "../..")

export const GREENFIELD_USER_DEPLOYED_GUIDE_PATH = path.resolve(
  serverRoot,
  "../../public-docs/user-deployed-cloudflare.md",
)

const checkedGuideEnvironment = Object.freeze({
  CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
  CLAXEDO_PRODUCT_POSTURE: "user-deployed",
  CLAXEDO_SANDBOX_POSTURE: "control-plane-only",
  CLAXEDO_PRODUCTION_DEPLOYMENT_ID: "deployment-production-guide",
  CLAXEDO_STAGING_DEPLOYMENT_ID: "deployment-staging-guide",
  CLAXEDO_RELEASE_SEQUENCE: "1",
  CLAXEDO_RELEASE_ID: "release-greenfield-guide",
  CLAXEDO_AUTH_METHODS: "github",
  CLAXEDO_PRODUCTION_API_ORIGIN: "https://api.example.com",
  CLAXEDO_STAGING_API_ORIGIN: "https://api-staging.example.com",
  CLAXEDO_PRODUCTION_APP_ORIGIN: "https://app.example.com",
  CLAXEDO_STAGING_APP_ORIGIN: "https://app-staging.example.com",
  GITHUB_CLIENT_ID: "bring-your-own-github-client",
  BETTER_AUTH_SECRET: "guide-better-auth-secret-at-least-32-characters",
  CLAXEDO_AUTH_INTROSPECTION_SECRET: "guide-introspection-secret-at-least-32-characters",
  CLAXEDO_RELEASE_OPERATOR_SECRET: "guide-release-operator-secret-at-least-32-characters",
  CLAXEDO_PRODUCTION_AUTH_D1_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
  CLAXEDO_STAGING_AUTH_D1_DATABASE_ID: "22222222-2222-2222-2222-222222222222",
  CLAXEDO_PRODUCTION_AUTH_D1_DATABASE_NAME: "claxedo-auth-production",
  CLAXEDO_STAGING_AUTH_D1_DATABASE_NAME: "claxedo-auth-staging",
  CLAXEDO_PRODUCTION_CONTROL_PLANE_D1_DATABASE_ID: "33333333-3333-3333-3333-333333333333",
  CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_ID: "44444444-4444-4444-4444-444444444444",
  CLAXEDO_PRODUCTION_CONTROL_PLANE_D1_DATABASE_NAME: "claxedo-control-plane-production",
  CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME: "claxedo-control-plane-staging",
}) satisfies NodeJS.ProcessEnv

export type GreenfieldUserDeployedPreflight = Readonly<{
  environment: BetterAuthD1ReleaseEnvironment
  workerName: string
  product: (typeof STATIC_PRODUCT_DESCRIPTORS)["user-deployed"]
  auth: Readonly<{
    adapter: "better-auth-d1"
    methods: readonly ("github" | "google")[]
    publicVariables: readonly string[]
    secrets: readonly string[]
    callbackUrls: readonly string[]
  }>
  resources: readonly Readonly<{
    binding: "AUTH_DB" | "CONTROL_PLANE_DB" | "CLAXEDO_REQUEST_LIMITER"
    kind: "d1" | "rate-limit"
    name?: string
  }>[]
  databaseProvisioning: readonly Readonly<{
    environment: BetterAuthD1ReleaseEnvironment
    binding: "AUTH_DB" | "CONTROL_PLANE_DB"
    name: string
  }>[]
  terminalPhase: "locked"
  wranglerConfig: string
}>

export function requireGreenfieldUserDeployedResourceClosure(config: string) {
  const d1Bindings = [...config.matchAll(/\[\[d1_databases\]\]\s+binding = "([^"]+)"/g)].map((match) => match[1])
  const rateLimitBindings = [...config.matchAll(/\[\[ratelimits\]\]\s+name = "([^"]+)"/g)].map((match) => match[1])
  const forbidden = [
    "[[r2_buckets]]",
    "[[durable_objects",
    "[[queues",
    "[[kv_namespaces",
    "[[services]]",
    "[[migrations]]",
    "[triggers]",
    "workgraph",
    "document",
    "polar",
    "billing",
    "convex",
    "clerk",
    "sandbox_driver",
  ]
  const lowered = config.toLowerCase()
  if (
    d1Bindings.length !== 2 ||
    d1Bindings[0] !== "AUTH_DB" ||
    d1Bindings[1] !== "CONTROL_PLANE_DB" ||
    rateLimitBindings.length !== 1 ||
    rateLimitBindings[0] !== "CLAXEDO_REQUEST_LIMITER" ||
    forbidden.some((token) => lowered.includes(token))
  ) {
    throw new Error("greenfield user-deployed Wrangler resource closure contains an unselected resource")
  }
  return config
}

export function greenfieldUserDeployedPreflight(
  env: NodeJS.ProcessEnv,
  environment: BetterAuthD1ReleaseEnvironment,
): GreenfieldUserDeployedPreflight {
  for (const name of [
    "BETTER_AUTH_SECRET",
    "CLAXEDO_AUTH_INTROSPECTION_SECRET",
    "CLAXEDO_RELEASE_OPERATOR_SECRET",
  ] as const) {
    if ((env[name]?.trim().length ?? 0) < 32) {
      throw new Error(`${name} must be a deployment-owned secret of at least 32 characters`)
    }
  }
  const trustSecrets = [
    "BETTER_AUTH_SECRET",
    "CLAXEDO_AUTH_INTROSPECTION_SECRET",
    "CLAXEDO_RELEASE_OPERATOR_SECRET",
  ].map((name) => env[name]!.trim())
  if (new Set(trustSecrets).size !== trustSecrets.length) {
    throw new Error("auth, introspection, and release-operator secrets must be distinct trust identities")
  }
  const release = betterAuthD1ReleaseInputs(env, environment)
  const releases = {
    production: environment === "production" ? release : betterAuthD1ReleaseInputs(env, "production"),
    staging: environment === "staging" ? release : betterAuthD1ReleaseInputs(env, "staging"),
  }
  const wranglerConfig = renderBetterAuthD1WranglerConfig({
    staging: environment === "staging",
    ...release,
  })
  requireGreenfieldUserDeployedResourceClosure(wranglerConfig)
  const socialMethods = release.authConfiguration.methods.filter(
    (method): method is "github" | "google" => method === "github" || method === "google",
  )
  if (socialMethods.length !== release.authConfiguration.methods.length) {
    throw new Error("greenfield user-deployed requires social auth until an email-sender service is installed")
  }
  return Object.freeze({
    environment,
    workerName: betterAuthD1WorkerName(environment),
    product: STATIC_PRODUCT_DESCRIPTORS["user-deployed"],
    auth: Object.freeze({
      adapter: "better-auth-d1" as const,
      methods: Object.freeze(socialMethods),
      publicVariables: Object.freeze(release.publicProviderVariables.map(([name]) => name)),
      secrets: Object.freeze([...release.requiredSecrets]),
      callbackUrls: Object.freeze(
        (["production", "staging"] as const).flatMap((target) =>
          socialMethods.map((method) => `${releases[target].apiOrigin}/api/auth/callback/${method}`),
        ),
      ),
    }),
    resources: Object.freeze([
      Object.freeze({ binding: "AUTH_DB" as const, kind: "d1" as const, name: release.authDatabaseName }),
      Object.freeze({
        binding: "CONTROL_PLANE_DB" as const,
        kind: "d1" as const,
        name: release.controlPlaneDatabaseName,
      }),
      Object.freeze({ binding: "CLAXEDO_REQUEST_LIMITER" as const, kind: "rate-limit" as const }),
    ]),
    databaseProvisioning: Object.freeze(
      (["production", "staging"] as const).flatMap((target) => [
        Object.freeze({ environment: target, binding: "AUTH_DB" as const, name: releases[target].authDatabaseName }),
        Object.freeze({
          environment: target,
          binding: "CONTROL_PLANE_DB" as const,
          name: releases[target].controlPlaneDatabaseName,
        }),
      ]),
    ),
    terminalPhase: "locked" as const,
    wranglerConfig,
  })
}

function shellArgument(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function providerLabel(method: "github" | "google") {
  return method === "github" ? "GitHub" : "Google"
}

export function renderGreenfieldUserDeployedGuide(preflight: GreenfieldUserDeployedPreflight) {
  const stagingFlag = preflight.environment === "staging" ? " --staging" : ""
  const providerNames = preflight.auth.methods.map(providerLabel).join(" + ")
  const providerVariables = preflight.auth.publicVariables
    .map((name) => `export ${name}='<bring your own provider client ID>'`)
    .join("\n")
  const secretCommands = preflight.auth.secrets
    .map((name) => `./node_modules/.bin/wrangler secret put ${name} --name ${shellArgument(preflight.workerName)}`)
    .join("\n")
  const databaseCommands = preflight.databaseProvisioning
    .map((database) => `./node_modules/.bin/wrangler d1 create ${shellArgument(database.name)}`)
    .join("\n")
  const databaseEnvironment = preflight.databaseProvisioning
    .map((database) => {
      const prefix = `CLAXEDO_${database.environment.toUpperCase()}_${database.binding === "AUTH_DB" ? "AUTH" : "CONTROL_PLANE"}_D1_DATABASE`
      return `export ${prefix}_NAME=${shellArgument(database.name)}\nexport ${prefix}_ID='<UUID printed by d1 create>'`
    })
    .join("\n")

  return `# User-deployed Claxedo on Cloudflare

> Generated by \`packages/claxedo-server/scripts/deploy/greenfield-user-deployed.ts\`. This guide selects
> ${providerNames}. To select another supported OAuth method, set \`CLAXEDO_AUTH_METHODS\` and run \`bun run docs:user-cloudflare:print\`;
> the generated provider variables, callback, and secrets will contain only that selection.

This workflow targets the static user-deployed product: one organization, multiplayer, Better Auth + D1,
billing absent, and an empty optional-service catalog. The Worker uses the control-plane-only posture; it does
not deploy an execution sandbox, relay, browser application, or optional service.

**Current ceiling: \`locked\` — not open.** The repository can deploy and verify a fail-closed locked control-plane
Worker. The persisted operator gates exist, but this artifact deliberately has no browser build or admitted product routes,
so it cannot begin canary or admit users and ordinary application traffic.

## 1. Prerequisites

- A Cloudflare account authenticated for Workers, D1, custom domains, and rate-limit bindings.
- Four unused D1 databases: separate auth and control-plane databases for production and staging.
- Distinct exact HTTPS custom API and app origins for production and staging. Workers.dev and Pages.dev origins
  are rejected by the release script. The app origins are trust inputs only in this locked slice; no browser app is published.
- A bring-your-own ${providerNames} OAuth app. Configure only the selected callback URIs:
${preflight.auth.callbackUrls.map((callback) => `  - \`${callback}\``).join("\n")}
- Bun 1.3.14 and the repository dependencies installed from the reviewed commit.

Run from \`packages/claxedo-server\`:

\`\`\`bash
./node_modules/.bin/wrangler whoami
${databaseCommands}
\`\`\`

Record each returned UUID. Resource creation is deliberately outside the release script so the operator can review
account, names, and physical production/staging isolation before deployment.

## 2. Configure the certified profile

Use a private shell or secret manager; do not commit this environment.

\`\`\`bash
export CLAXEDO_ADAPTER_PROFILE='better-auth-d1'
export CLAXEDO_PRODUCT_POSTURE='user-deployed'
export CLAXEDO_SANDBOX_POSTURE='control-plane-only'
export CLAXEDO_AUTH_METHODS=${shellArgument(preflight.auth.methods.join(","))}

export CLAXEDO_PRODUCTION_DEPLOYMENT_ID='<unique production deployment ID>'
export CLAXEDO_STAGING_DEPLOYMENT_ID='<different staging deployment ID>'
export CLAXEDO_RELEASE_SEQUENCE='1'
export CLAXEDO_RELEASE_ID='<unique release ID>'

export CLAXEDO_PRODUCTION_API_ORIGIN='https://api.example.com'
export CLAXEDO_STAGING_API_ORIGIN='https://api-staging.example.com'
export CLAXEDO_PRODUCTION_APP_ORIGIN='https://app.example.com'
export CLAXEDO_STAGING_APP_ORIGIN='https://app-staging.example.com'

${databaseEnvironment}
export BETTER_AUTH_SECRET='<deployment-owned secret of at least 32 characters>'
export CLAXEDO_AUTH_INTROSPECTION_SECRET='<different deployment-owned secret of at least 32 characters>'
export CLAXEDO_RELEASE_OPERATOR_SECRET='<different deployment-owned operator secret of at least 32 characters>'
${providerVariables}
\`\`\`

The selected Worker secret inventory is exactly:

${preflight.auth.secrets.map((name) => `- \`${name}\``).join("\n")}

No email/password method is certified in this workflow because there is no installed email-sender service.

## 3. Run the non-mutating local preflight

\`\`\`bash
bun run deploy:user-cloudflare:preflight${stagingFlag}
\`\`\`

This validates the product/profile axes, origin shape, production/staging isolation, selected provider inventory,
and generated Wrangler resource closure. It prints no secret values and creates nothing.

## 4. Install the fail-closed bootstrap Worker

The first deploy refuses to replace an existing Worker and requires the exact target name as an explicit confirmation.

\`\`\`bash
export CLAXEDO_BOOTSTRAP_CONFIRM_WORKER_NAME=${shellArgument(preflight.workerName)}
bun run scripts/deploy/release-better-auth-d1.ts --deploy --bootstrap${stagingFlag}
\`\`\`

The command verifies both D1 bindings, proves the Worker has no existing deployment, deploys only the bootstrap gate,
and requires the custom domain to return the exact \`deployment_bootstrap\` 503 response.

## 5. Install only the selected secrets

For the first three prompts, enter the exact deployment-owned values exported in section 2. The selected provider prompt
uses the client secret from your own ${providerNames} OAuth app:

\`\`\`bash
${secretCommands}
\`\`\`

## 6. Certify without deploying the candidate

\`\`\`bash
bun run scripts/deploy/release-better-auth-d1.ts${stagingFlag}
\`\`\`

This is the remote preflight: it verifies both D1 resources and the exact remote secret inventory, renders the generated
Wrangler config, bundles the one locked entrypoint, and prints its SHA-256 artifact identity. It does not upload or migrate.

## 7. Deploy and verify the locked release

\`\`\`bash
bun run scripts/deploy/release-better-auth-d1.ts --deploy${stagingFlag}
\`\`\`

The executable sequence is: private version upload; auth and control-plane migrations; native-client provisioning;
persisted locked candidate registration; 0% candidate deployment beside the incumbent; version-override health smoke;
locked active-pointer CAS; exact locked health verification; then promotion of those same bytes to 100%. Promotion failure
restores the healthy incumbent and appends the release-state rollback record when a predecessor exists.

Stop here. A successful command means the locked control-plane artifact is deployed and verified; it does **not** mean
the user-deployed product is open, the one-organization bootstrap owner has been admitted, or multiplayer is released.

## Persisted cutover operator

The deployed Worker now exposes an authenticated, typed operator API and the repository includes its executable client.
Inspect the exact persisted release/build/profile binding with:

\`\`\`bash
bun run scripts/deploy/cutover-better-auth-d1.ts --status${stagingFlag}
\`\`\`

Before any canary-capable artifact may leave \`locked\`, prove that this is genuinely a greenfield target. The producer
queries both remote D1 databases, rejects unknown tables, checks the exact static provisioning rows, requires every
authentication/application/service-installation table to be empty, and binds the evidence to the generated deployment
manifest plus the concrete D1 database IDs:

\`\`\`bash
mkdir -p .artifacts/deployments
bun run scripts/deploy/prove-greenfield-target-absence.ts${stagingFlag} \\
  > .artifacts/deployments/greenfield-target-absence.json
export CLAXEDO_CUTOVER_TARGET_ABSENCE_SHA256="$(node -p 'require("./.artifacts/deployments/greenfield-target-absence.json").targetAbsenceSha256')"
export CLAXEDO_CUTOVER_DEPLOYMENT_MANIFEST_SHA256="$(node -p 'require("./.artifacts/deployments/greenfield-target-absence.json").deploymentManifestSha256')"
export CLAXEDO_CUTOVER_RECEIPT_ID='<unique immutable receipt ID>'
export CLAXEDO_CUTOVER_OPERATION_ID='<unique idempotent operation ID>'
bun run scripts/deploy/cutover-better-auth-d1.ts --record-greenfield-source-absence-verified${stagingFlag}
\`\`\`

Do not substitute hand-written hashes. The proof command derives both SHA-256 identities from the queried target and the
manifest emitted by the exact release command.

The client also implements \`--begin-canary\`, \`--record-canary-complete\`, \`--advance-provider-sync\`, typed
provider-sync receipt commands, \`--advance-multiplayer-validation\`, two identity-registration commands, six typed
multiplayer receipt commands, and \`--open\`. It has no raw phase or arbitrary evidence input. Every mutation is bound
to the active release, Worker/browser/auth builds, certified profile, state revision, and phase revision; stale and
replayed requests fail closed.

**Apart from the producer-backed greenfield evidence receipt above, do not run phase-changing or later-phase evidence
commands for this locked-only artifact.** Its persisted browser identity is
\`browser-absent-v1\`, so both the client and Worker reject \`--begin-canary\`. A later cutover-capable artifact must
bind the real browser build and route its one authorized canary mutation through the serialized first-write API.
The remaining typed evidence commands record operator attestations after callback drain, authority reconciliation,
paired backup, and the real two-identity multiplayer harness have run; they do not perform or claim those external
rehearsals.

The remaining phase order enforced by the persisted gate is:

| Phase | Required durable receipts before the next transition |
| --- | --- |
| \`canary\` | One deployment-authorized identity/journey, its irreversible first-write boundary, and completed journey. |
| \`provider_sync\` | Callback capture ready, inbox pending count zero, authority unresolved count zero, user-deployed billing closure absent, and matching auth/control-plane backup epoch. |
| \`multiplayer_validation\` | Exactly two release-bound identity hashes plus private-session, stream, revocation, wrong-org, replay, and outage receipts covering that pair. |
| \`open\` | All prior receipts and an exact SHA-256 browser build (plus a relay build for the hosted product). |

For a later cutover-capable artifact already in \`provider_sync\`, produce the paired-backup receipt from exported bytes,
not hand-entered hashes. The command writes both credential-bearing exports into a mode-0700 directory with mode-0600
files, restores them into fresh local SQLite databases, runs integrity/schema/count checks, and verifies the active
provider-sync release plus the same recovery epoch in both halves:

\`\`\`bash
bun run scripts/deploy/verify-paired-d1-backup.ts --export-and-verify${stagingFlag} \\
  > .artifacts/deployments/paired-d1-backup-evidence.json
export CLAXEDO_CUTOVER_RECOVERY_EPOCH="$(node -p 'require("./.artifacts/deployments/paired-d1-backup-evidence.json").recoveryEpoch')"
export CLAXEDO_CUTOVER_AUTH_BACKUP_SHA256="$(node -p 'require("./.artifacts/deployments/paired-d1-backup-evidence.json").authBackupSha256')"
export CLAXEDO_CUTOVER_CONTROL_PLANE_BACKUP_SHA256="$(node -p 'require("./.artifacts/deployments/paired-d1-backup-evidence.json").controlPlaneBackupSha256')"
export CLAXEDO_CUTOVER_RECEIPT_ID='<unique immutable receipt ID>'
export CLAXEDO_CUTOVER_OPERATION_ID='<unique idempotent operation ID>'
bun run scripts/deploy/cutover-better-auth-d1.ts --record-paired-backup-verified${stagingFlag}
\`\`\`

Keep these exports under the migration custody/retention policy: they contain authentication and application data. A
production rehearsal must additionally restore them into fresh remote D1 databases, bind both to one dark candidate,
and rerun the same epoch/identity probes before this local verifier is considered production recovery evidence.

Do not deploy a browser app, route ordinary traffic, or describe this instance as usable until those persisted gates and
their rollback/verification paths exist. Optional services are installed later as independent Workers through their own
resource manifests and lifecycle workflows; this core workflow never provisions them.
`
}

export function checkedGreenfieldUserDeployedGuide() {
  return renderGreenfieldUserDeployedGuide(greenfieldUserDeployedPreflight(checkedGuideEnvironment, "production"))
}

function preflightOutput(preflight: GreenfieldUserDeployedPreflight) {
  return JSON.stringify(
    {
      environment: preflight.environment,
      workerName: preflight.workerName,
      product: preflight.product,
      auth: preflight.auth,
      resources: preflight.resources,
      terminalPhase: preflight.terminalPhase,
      nextCommand: `bun run scripts/deploy/release-better-auth-d1.ts${
        preflight.environment === "staging" ? " --staging" : ""
      }`,
    },
    null,
    2,
  )
}

async function main() {
  const staging = process.argv.includes("--staging")
  const environment = staging ? "staging" : "production"
  const actions = ["--preflight", "--print-guide", "--check-guide", "--write-guide"].filter((flag) =>
    process.argv.includes(flag),
  )
  if (actions.length !== 1) {
    throw new Error("choose exactly one of --preflight, --print-guide, --check-guide, or --write-guide")
  }
  const action = actions[0]
  if (action === "--check-guide" || action === "--write-guide") {
    if (staging) throw new Error(`${action} uses the canonical production guide and does not accept --staging`)
    const generated = checkedGreenfieldUserDeployedGuide()
    if (action === "--write-guide") {
      await writeFile(GREENFIELD_USER_DEPLOYED_GUIDE_PATH, generated)
      console.log(`wrote ${GREENFIELD_USER_DEPLOYED_GUIDE_PATH}`)
      return
    }
    const current = await readFile(GREENFIELD_USER_DEPLOYED_GUIDE_PATH, "utf8")
    if (current !== generated) {
      throw new Error("public-docs/user-deployed-cloudflare.md is stale; run docs:user-cloudflare:write")
    }
    console.log("user-deployed Cloudflare guide is current")
    return
  }
  const preflight = greenfieldUserDeployedPreflight(process.env, environment)
  if (action === "--print-guide") {
    process.stdout.write(renderGreenfieldUserDeployedGuide(preflight))
    return
  }
  console.log(preflightOutput(preflight))
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) await main()
