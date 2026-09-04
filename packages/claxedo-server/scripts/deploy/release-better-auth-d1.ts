import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { Resolver } from "node:dns/promises"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { request as httpsRequest } from "node:https"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { resolveDeploymentProfileFromEnv } from "../../src/deployments/hosted-shared/deployment-profile"
import {
  LOCKED_BROWSER_BUILD_ID,
  LOCKED_RELAY_BUILD_ID,
  LOCKED_SERVICE_MANIFEST_ID,
} from "../../src/deployments/hosted-workerd/better-auth-d1-release-state.cf"
import {
  betterAuthDeploymentConfigurationId,
  resolveBetterAuthMethodSelection,
} from "../../src/platform/auth/better-auth-configuration"
import {
  certifiedHostedWorkerArtifact,
  type CertifiedHostedWorkerEnvironment,
} from "../../src/deployments/hosted-workerd/certified-worker-artifacts"
import { isTransientWranglerFailure } from "./prepare-better-auth-d1"

const serverRoot = path.resolve(import.meta.dirname, "../..")
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BETTER_AUTH_D1_LOCKED_ARTIFACT = "user-deployed-better-auth-d1-locked" as const
const BETTER_AUTH_D1_LIVE_SYNC_MIGRATION_BRIDGE_ARTIFACT =
  "user-deployed-better-auth-d1-live-sync-migration-bridge" as const
const BETTER_AUTH_D1_CUTOVER_ARTIFACT = "user-deployed-better-auth-d1-candidate" as const
const BETTER_AUTH_D1_CUTOVER_AGENT_PLUGINS_ARTIFACT = "user-deployed-better-auth-d1-candidate-agent-plugins" as const
const BETTER_AUTH_D1_CUTOVER_AGENT_PLUGINS_FULL_HOSTED_ARTIFACT =
  "user-deployed-better-auth-d1-candidate-agent-plugins-full-hosted" as const

export type BetterAuthD1SandboxDriver = "cloudflare" | "daytona" | "exe" | "fetch"

/** The secret each full-hosted driver needs on the Worker, checked against the inventory before release. */
const SANDBOX_DRIVER_SECRETS: Readonly<Record<BetterAuthD1SandboxDriver, readonly string[]>> = Object.freeze({
  cloudflare: ["CLOUDFLARE_SANDBOX_API_TOKEN"],
  daytona: ["DAYTONA_API_KEY"],
  exe: ["EXE_DEV_API_TOKEN"],
  fetch: [],
})
const publicDnsResolver = new Resolver()
publicDnsResolver.setServers(["1.1.1.1", "1.0.0.1"])

function resolvePublicIpv4(hostname: string) {
  return publicDnsResolver.resolve4(hostname)
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required for Better Auth D1 release`)
  return value
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string) {
  const value = required(env, name)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

export function futureUnixMilliseconds(env: NodeJS.ProcessEnv, name: string, now = Date.now()) {
  const value = required(env, name)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= now) {
    throw new Error(`${name} must be a future Unix timestamp in milliseconds`)
  }
  return value
}

function exactHttpsOrigin(env: NodeJS.ProcessEnv, name: string) {
  const value = required(env, name)
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(`${name} must be an exact HTTPS origin`)
  return url
}

export type BetterAuthD1ReleaseEnvironment = CertifiedHostedWorkerEnvironment
export type BetterAuthD1ReleaseMode = "locked" | "cutover"

export function betterAuthD1WorkerName(environment: BetterAuthD1ReleaseEnvironment) {
  return certifiedHostedWorkerArtifact(BETTER_AUTH_D1_LOCKED_ARTIFACT, environment).workerName
}

export function betterAuthD1DeploymentManifestPath(
  env: NodeJS.ProcessEnv,
  environment: BetterAuthD1ReleaseEnvironment,
) {
  const configured = env.CLAXEDO_DEPLOYMENT_MANIFEST_PATH?.trim()
  if (configured) return path.resolve(configured)
  const releaseId = required(env, "CLAXEDO_RELEASE_ID")
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(releaseId)) {
    throw new Error("CLAXEDO_RELEASE_ID cannot be used as a deployment manifest filename")
  }
  return path.join(serverRoot, ".artifacts", "deployments", `${environment}-${releaseId}.json`)
}

export function betterAuthD1DeploymentManifest(input: {
  release: ReturnType<typeof betterAuthD1ReleaseInputs>
  workerBuildId: string
  platformVersionId: string
  authConfigurationId: string
}) {
  const variable = (name: string) => {
    const value = input.release.runtimeVariables.find(([candidate]) => candidate === name)?.[1]
    if (!value) throw new Error(`deployment manifest is missing ${name}`)
    return value
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    deploymentId: variable("CLAXEDO_DEPLOYMENT_ID"),
    releaseSequence: Number(variable("CLAXEDO_RELEASE_SEQUENCE")),
    releaseId: variable("CLAXEDO_RELEASE_ID"),
    environment: input.release.environment,
    adapterProfile: "better-auth-d1" as const,
    productPosture: "user-deployed" as const,
    sandboxPosture: input.release.sandbox ? ("full-hosted" as const) : ("control-plane-only" as const),
    ...(input.release.sandbox ? { sandboxDriver: input.release.sandbox.driver } : {}),
    workerBuildId: input.workerBuildId,
    platformVersionId: input.platformVersionId,
    browserBuildId: input.release.browserBuildId,
    relayBuildId: input.release.relayBuildId,
    authConfigurationId: input.authConfigurationId,
    serviceManifestId: LOCKED_SERVICE_MANIFEST_ID,
    recoveryEpoch: variable("CLAXEDO_RECOVERY_EPOCH"),
    apiOrigin: input.release.apiOrigin,
    appOrigin: input.release.authConfiguration.appOrigin,
    authMethods: Object.freeze([...input.release.authConfiguration.methods].sort()),
    ...(input.release.agentPlugins
      ? {
          agentPlugins: Object.freeze({
            artifactBucket: Object.freeze({ binding: "CLAXEDO_AGENT_PLUGINS" as const, bucketName: input.release.agentPlugins.bucketName }),
            credentialsNamespace: Object.freeze({
              binding: "CLAXEDO_CREDENTIALS" as const,
              namespaceId: input.release.agentPlugins.credentialsNamespaceId,
            }),
          }),
        }
      : {}),
    resources: Object.freeze({
      authDatabase: Object.freeze({
        binding: "AUTH_DB" as const,
        databaseId: input.release.authDatabaseId,
        databaseName: input.release.authDatabaseName,
      }),
      controlPlaneDatabase: Object.freeze({
        binding: "CONTROL_PLANE_DB" as const,
        databaseId: input.release.controlPlaneDatabaseId,
        databaseName: input.release.controlPlaneDatabaseName,
      }),
      requestLimiter: Object.freeze({
        binding: "CLAXEDO_REQUEST_LIMITER" as const,
        namespaceId: input.release.namespaceId,
      }),
    }),
  })
}

export function allocatedRequestLimiterNamespaceId(deploymentId: string, workerName: string) {
  const digest = createHash("sha256").update(`claxedo:ratelimit:v1:${deploymentId}:${workerName}`).digest()
  return String(1_000_000_000 + (digest.readUInt32BE(0) % 3_000_000_000))
}

export function pairedD1RecoveryEpoch(input: {
  deploymentId: string
  releaseId: string
  authDatabaseId: string
  controlPlaneDatabaseId: string
}) {
  return `paired-d1-v1:sha256:${createHash("sha256")
    .update(
      `claxedo:paired-d1:v1:${input.deploymentId}:${input.releaseId}:${input.authDatabaseId}:${input.controlPlaneDatabaseId}`,
    )
    .digest("hex")}`
}

function environmentValue(env: NodeJS.ProcessEnv, environment: BetterAuthD1ReleaseEnvironment, suffix: string) {
  return required(env, `CLAXEDO_${environment.toUpperCase()}_${suffix}`)
}

function assertIsolatedDeploymentResources(env: NodeJS.ProcessEnv) {
  const fields = [
    "DEPLOYMENT_ID",
    "API_ORIGIN",
    "APP_ORIGIN",
    "WORKSPACE_RELAY_URL",
    "AUTH_D1_DATABASE_ID",
    "AUTH_D1_DATABASE_NAME",
    "CONTROL_PLANE_D1_DATABASE_ID",
    "CONTROL_PLANE_D1_DATABASE_NAME",
  ] as const
  for (const field of fields) {
    const production = environmentValue(env, "production", field)
    const staging = environmentValue(env, "staging", field)
    if (production === staging) {
      throw new Error(`production and staging ${field} must be distinct`)
    }
  }
  for (const environment of ["production", "staging"] as const) {
    if (
      environmentValue(env, environment, "AUTH_D1_DATABASE_ID") ===
      environmentValue(env, environment, "CONTROL_PLANE_D1_DATABASE_ID")
    ) {
      throw new Error(`${environment} AUTH and CONTROL_PLANE database IDs must be distinct`)
    }
    if (
      environmentValue(env, environment, "AUTH_D1_DATABASE_NAME") ===
      environmentValue(env, environment, "CONTROL_PLANE_D1_DATABASE_NAME")
    ) {
      throw new Error(`${environment} AUTH and CONTROL_PLANE database names must be distinct`)
    }
  }
  const productionNamespace = allocatedRequestLimiterNamespaceId(
    environmentValue(env, "production", "DEPLOYMENT_ID"),
    betterAuthD1WorkerName("production"),
  )
  const stagingNamespace = allocatedRequestLimiterNamespaceId(
    environmentValue(env, "staging", "DEPLOYMENT_ID"),
    betterAuthD1WorkerName("staging"),
  )
  if (productionNamespace === stagingNamespace) {
    throw new Error("production and staging deployment IDs collide in the allocated limiter namespace")
  }
}

export function betterAuthD1ReleaseInputs(
  env: NodeJS.ProcessEnv,
  environment: BetterAuthD1ReleaseEnvironment,
  options: Readonly<{ mode: BetterAuthD1ReleaseMode; browserBuildId?: string; agentPlugins?: boolean }> = { mode: "locked" },
) {
  const profile = resolveDeploymentProfileFromEnv(env)
  if (profile.adapterProfile !== "better-auth-d1" || profile.productPosture !== "user-deployed") {
    throw new Error("Better Auth D1 release supports only the user-deployed product")
  }
  // Full-hosted is a cutover-only, Agent Plugins-only artifact: the certified
  // candidate that carries a sandbox provider is the feature candidate, and
  // the locked/bootstrap train never executes workspaces.
  // The locked/bootstrap train never executes workspaces, so a full-hosted
  // profile only shapes the cutover candidate; a locked preflight over the same
  // environment still renders the control-plane-only locked Worker.
  if (profile.sandboxPosture === "full-hosted" && options.mode === "cutover" && !options.agentPlugins) {
    throw new Error("full-hosted Better Auth D1 requires the Agent Plugins candidate (--agent-plugins)")
  }
  const sandbox = profile.sandboxPosture === "full-hosted" && options.mode === "cutover"
    ? { driver: profile.sandboxDriver as BetterAuthD1SandboxDriver }
    : undefined
  if (sandbox && !(sandbox.driver in SANDBOX_DRIVER_SECRETS)) {
    throw new Error(`Better Auth D1 full-hosted supports drivers ${Object.keys(SANDBOX_DRIVER_SECRETS).join(", ")}; got ${sandbox.driver}`)
  }
  if (env.CLAXEDO_WORKER_BUILD_ID?.trim() || env.CLAXEDO_BROWSER_BUILD_ID?.trim()) {
    throw new Error("Worker and browser build IDs are derived from emitted artifacts and must not be supplied")
  }
  const browserBuildId = options.mode === "locked" ? LOCKED_BROWSER_BUILD_ID : options.browserBuildId?.trim()
  if (!browserBuildId || (options.mode === "cutover" && !/^sha256:[0-9a-f]{64}$/.test(browserBuildId))) {
    throw new Error("cutover release requires a derived SHA-256 browser build identity")
  }
  assertIsolatedDeploymentResources(env)
  const methods = resolveBetterAuthMethodSelection(required(env, "CLAXEDO_AUTH_METHODS"))
  if (methods.includes("email-password")) {
    throw new Error("email-password deployment requires an installed email-sender service")
  }
  const publicProviderVariables = methods.map((method) => {
    const name = method === "google" ? "GOOGLE_CLIENT_ID" : "GITHUB_CLIENT_ID"
    return [name, required(env, name)] as const
  })
  const apiOriginName = `CLAXEDO_${environment.toUpperCase()}_API_ORIGIN`
  const apiOrigin = exactHttpsOrigin(env, apiOriginName)
  if (
    apiOrigin.protocol !== "https:" ||
    apiOrigin.origin !== env[apiOriginName]?.trim() ||
    apiOrigin.hostname.endsWith(".workers.dev") ||
    apiOrigin.hostname.endsWith(".pages.dev")
  )
    throw new Error(`${apiOriginName} must be the exact HTTPS custom API origin`)
  const authDatabaseId = environmentValue(env, environment, "AUTH_D1_DATABASE_ID")
  const controlPlaneDatabaseId = environmentValue(env, environment, "CONTROL_PLANE_D1_DATABASE_ID")
  for (const [resource, databaseId] of [
    ["AUTH", authDatabaseId],
    ["CONTROL_PLANE", controlPlaneDatabaseId],
  ] as const) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)) {
      throw new Error(`CLAXEDO_${environment.toUpperCase()}_${resource}_D1_DATABASE_ID must be a real D1 UUID`)
    }
  }
  const namespaceId = allocatedRequestLimiterNamespaceId(
    environmentValue(env, environment, "DEPLOYMENT_ID"),
    betterAuthD1WorkerName(environment),
  )
  if (env.CLAXEDO_PREVIOUS_PHASE?.trim() === "open") {
    // The ledger records this succession as `open_rollforward`, but the
    // certified pipeline has no zero-downtime traffic switch yet: the new
    // version takes 100% while the ledger still names the open predecessor,
    // so every request identity-fails until the candidate is activated. A
    // development staging accepts those seconds of unavailability the same
    // way it accepts `--dev-open`; production must wait for the versioned
    // candidate traffic-switch deployer.
    const devRollForward = env.CLAXEDO_DEV_OPEN_ROLL_FORWARD?.trim() === "1"
    if (environment !== "staging" || !devRollForward) {
      throw new Error("open roll-forward requires the versioned candidate traffic-switch deployer")
    }
  }
  const transitionNames = [
    "CLAXEDO_PREVIOUS_RELEASE_ID",
    "CLAXEDO_PREVIOUS_STATE_REVISION",
    "CLAXEDO_PREVIOUS_PHASE",
    "CLAXEDO_PREVIOUS_PHASE_REVISION",
    "CLAXEDO_RELEASE_OPERATION_ID",
  ] as const
  const transitionValues = transitionNames.filter((name) => env[name]?.trim())
  if (transitionValues.length !== 0 && transitionValues.length !== transitionNames.length) {
    throw new Error("all Better Auth D1 successor CAS inputs must be provided together")
  }
  const releaseId = required(env, "CLAXEDO_RELEASE_ID")
  const deploymentId = environmentValue(env, environment, "DEPLOYMENT_ID")
  const recoveryEpoch = pairedD1RecoveryEpoch({
    deploymentId,
    releaseId,
    authDatabaseId,
    controlPlaneDatabaseId,
  })
  const previousStateRevision =
    transitionValues.length === 0 ? undefined : Number(required(env, "CLAXEDO_PREVIOUS_STATE_REVISION"))
  if (
    previousStateRevision !== undefined &&
    (!Number.isSafeInteger(previousStateRevision) || previousStateRevision < 0)
  ) {
    throw new Error("CLAXEDO_PREVIOUS_STATE_REVISION must be a non-negative integer")
  }
  // The Agent Plugins build binds the immutable artifact bucket and the
  // org-partitioned credential namespace, turns the hosted credential surface
  // on, and names the public origin the OAuth client identity document and the
  // MCP gateway are served from. All of it is release input, none of it is a
  // runtime discovery.
  const agentPlugins = options.agentPlugins
    ? {
        credentialsNamespaceId: (() => {
          const value = environmentValue(env, environment, "CREDENTIALS_KV_NAMESPACE_ID")
          if (!/^[0-9a-f]{32}$/i.test(value)) {
            throw new Error(`CLAXEDO_${environment.toUpperCase()}_CREDENTIALS_KV_NAMESPACE_ID must be a real KV namespace ID`)
          }
          return value
        })(),
        bucketName:
          env[`CLAXEDO_${environment.toUpperCase()}_AGENT_PLUGINS_BUCKET`]?.trim() ||
          (environment === "staging" ? "claxedo-agent-plugins-staging" : "claxedo-agent-plugins"),
      }
    : undefined
  // The driver's own configuration is release input too. Only the cloudflare
  // driver's sandbox Worker URL is a variable here; its token and the other
  // drivers' keys are Worker secrets checked against the inventory.
  const sandboxVariables: Array<readonly [string, string]> = sandbox
    ? [
        ["CLAXEDO_SANDBOX_DRIVER", sandbox.driver],
        ...(sandbox.driver === "cloudflare"
          ? ([["CLOUDFLARE_SANDBOX_WORKER_URL", exactHttpsOrigin(env, `CLAXEDO_${environment.toUpperCase()}_SANDBOX_WORKER_URL`).origin]] as const)
          : []),
        ...(sandbox.driver === "daytona" ? ([["CLAXEDO_DAYTONA_SNAPSHOT", required(env, "CLAXEDO_DAYTONA_SNAPSHOT")]] as const) : []),
        ...(sandbox.driver === "fetch" ? ([["CLAXEDO_SANDBOX_DRIVER_URL", exactHttpsOrigin(env, "CLAXEDO_SANDBOX_DRIVER_URL").origin]] as const) : []),
      ]
    : []
  const candidateStateRevision = previousStateRevision === undefined ? 0 : previousStateRevision + 1
  const candidateOperationId =
    previousStateRevision === undefined ? `initialize:${releaseId}` : required(env, "CLAXEDO_RELEASE_OPERATION_ID")
  const appOriginName = `CLAXEDO_${environment.toUpperCase()}_APP_ORIGIN`
  const appOrigin = exactHttpsOrigin(env, appOriginName).origin
  const relayUrlName = `CLAXEDO_${environment.toUpperCase()}_WORKSPACE_RELAY_URL`
  const relayUrl = exactHttpsOrigin(env, relayUrlName).origin
  const cutoverVariables =
    options.mode === "cutover"
      ? ([
          [
            "CLAXEDO_AUTH_DESCRIPTOR_EXPIRES_AT",
            futureUnixMilliseconds(env, "CLAXEDO_AUTH_DESCRIPTOR_EXPIRES_AT"),
          ],
          ["CLAXEDO_ENVIRONMENT_ID", required(env, "CLAXEDO_ENVIRONMENT_ID")],
          ["CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID", required(env, "CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID")],
          ["CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME", required(env, "CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME")],
          ["CLAXEDO_CANARY_JOURNEY_ID", required(env, "CLAXEDO_CANARY_JOURNEY_ID")],
        ] as const)
      : []
  return {
    mode: options.mode,
    ...(agentPlugins ? { agentPlugins } : {}),
    ...(sandbox ? { sandbox } : {}),
    browserBuildId,
    relayBuildId: LOCKED_RELAY_BUILD_ID,
    environment,
    apiOrigin: apiOrigin.origin,
    authDatabaseId,
    authDatabaseName: environmentValue(env, environment, "AUTH_D1_DATABASE_NAME"),
    controlPlaneDatabaseId,
    controlPlaneDatabaseName: environmentValue(env, environment, "CONTROL_PLANE_D1_DATABASE_NAME"),
    namespaceId,
    publicProviderVariables,
    authConfiguration: {
      methods,
      apiOrigin: apiOrigin.origin,
      appOrigin,
      ...(methods.includes("google") ? { googleClientId: required(env, "GOOGLE_CLIENT_ID") } : {}),
      ...(methods.includes("github") ? { githubClientId: required(env, "GITHUB_CLIENT_ID") } : {}),
    },
    requiredSecrets: [
      "BETTER_AUTH_SECRET",
      "CLAXEDO_AUTH_INTROSPECTION_SECRET",
      "CLAXEDO_RELEASE_OPERATOR_SECRET",
      "CLAXEDO_RELAY_RESOLVER_TOKEN",
      "CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM",
      "CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM",
      "CLAXEDO_RELAY_HOST_VERIFY_PEM",
      ...methods.map((method) => (method === "google" ? "GOOGLE_CLIENT_SECRET" : "GITHUB_CLIENT_SECRET")),
      ...(agentPlugins ? ["CLAXEDO_CREDENTIALS_KEK"] : []),
      ...(sandbox ? SANDBOX_DRIVER_SECRETS[sandbox.driver] : []),
    ],
    runtimeVariables: [
      ["CLAXEDO_DEPLOYMENT_MODE", "hosted"],
      ["CLAXEDO_DEPLOYMENT_ID", deploymentId],
      ["CLAXEDO_RELEASE_SEQUENCE", positiveInteger(env, "CLAXEDO_RELEASE_SEQUENCE")],
      ["CLAXEDO_RELEASE_ID", releaseId],
      ["CLAXEDO_CANDIDATE_STATE_REVISION", String(candidateStateRevision)],
      ["CLAXEDO_CANDIDATE_OPERATION_ID", candidateOperationId],
      ["CLAXEDO_AUTH_METHODS", methods.join(",")],
      ["CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID", namespaceId],
      ["CLAXEDO_RECOVERY_EPOCH", recoveryEpoch],
      ["CLAXEDO_BROWSER_BUILD_ID", browserBuildId],
      ["CLAXEDO_RELAY_BUILD_ID", LOCKED_RELAY_BUILD_ID],
      ["BETTER_AUTH_URL", apiOrigin.origin],
      ["CLAXEDO_APP_ORIGIN", appOrigin],
      ["CLAXEDO_WORKSPACE_RELAY_URL", relayUrl],
      ...cutoverVariables,
      ...publicProviderVariables,
      ...sandboxVariables,
      ...(agentPlugins
        ? ([
            ["CLAXEDO_HOSTED_CREDENTIALS_ENABLED", "1"],
            ["CLAXEDO_PUBLIC_URL", apiOrigin.origin],
            ["CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_STYLE", "origin"],
          ] as const)
        : []),
    ] as Array<readonly [string, string]>,
  }
}

type BetterAuthD1WranglerConfigInput = {
  staging: boolean
  mode?: BetterAuthD1ReleaseMode
  agentPlugins?: { credentialsNamespaceId: string; bucketName: string }
  sandbox?: { driver: BetterAuthD1SandboxDriver }
  authDatabaseId: string
  authDatabaseName: string
  controlPlaneDatabaseId: string
  controlPlaneDatabaseName: string
  namespaceId: string
}

function renderBetterAuthD1WranglerConfigForArtifact(
  input: BetterAuthD1WranglerConfigInput,
  artifactId:
    | typeof BETTER_AUTH_D1_LOCKED_ARTIFACT
    | typeof BETTER_AUTH_D1_LIVE_SYNC_MIGRATION_BRIDGE_ARTIFACT
    | typeof BETTER_AUTH_D1_CUTOVER_ARTIFACT
    | typeof BETTER_AUTH_D1_CUTOVER_AGENT_PLUGINS_ARTIFACT
    | typeof BETTER_AUTH_D1_CUTOVER_AGENT_PLUGINS_FULL_HOSTED_ARTIFACT,
  liveSyncResources: boolean,
) {
  const quote = (value: string) => JSON.stringify(value)
  const environment = input.staging ? "staging" : "production"
  const releaseTrain = certifiedHostedWorkerArtifact(BETTER_AUTH_D1_LOCKED_ARTIFACT, environment)
  const entrypoint = certifiedHostedWorkerArtifact(artifactId, environment).entrypointFromPackageChild
  const liveSyncConfiguration = liveSyncResources
    ? `
[[durable_objects.bindings]]
name = "LIVE_SYNC_ROOM"
class_name = "LiveSyncRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["LiveSyncRoom"]
`
    : ""
  const agentPluginsResources = input.agentPlugins
    ? `
[[r2_buckets]]
binding = "CLAXEDO_AGENT_PLUGINS"
bucket_name = ${quote(input.agentPlugins.bucketName)}

[[kv_namespaces]]
binding = "CLAXEDO_CREDENTIALS"
id = ${quote(input.agentPlugins.credentialsNamespaceId)}
`
    : ""
  return `name = ${quote(releaseTrain.workerName)}
main = ${quote(entrypoint)}
compatibility_date = "2025-05-01"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
workers_dev = false
preview_urls = false

[version_metadata]
binding = "CF_VERSION_METADATA"

[observability]
enabled = true

[vars]
CLAXEDO_ADAPTER_PROFILE = "better-auth-d1"
CLAXEDO_PRODUCT_POSTURE = "user-deployed"
CLAXEDO_SANDBOX_POSTURE = ${quote(input.sandbox ? "full-hosted" : "control-plane-only")}

[[d1_databases]]
binding = "AUTH_DB"
database_name = ${quote(input.authDatabaseName)}
database_id = ${quote(input.authDatabaseId)}
migrations_dir = "../migrations/auth"

[[d1_databases]]
binding = "CONTROL_PLANE_DB"
database_name = ${quote(input.controlPlaneDatabaseName)}
database_id = ${quote(input.controlPlaneDatabaseId)}
migrations_dir = "../migrations/control-plane"

[[ratelimits]]
name = "CLAXEDO_REQUEST_LIMITER"
namespace_id = ${quote(input.namespaceId)}
[ratelimits.simple]
limit = 600
period = 60
${liveSyncConfiguration}${agentPluginsResources}
`
}

export function betterAuthD1CutoverArtifact(agentPlugins: boolean, fullHosted = false) {
  if (fullHosted) {
    if (!agentPlugins) throw new Error("full-hosted Better Auth D1 is an Agent Plugins artifact")
    return BETTER_AUTH_D1_CUTOVER_AGENT_PLUGINS_FULL_HOSTED_ARTIFACT
  }
  return agentPlugins ? BETTER_AUTH_D1_CUTOVER_AGENT_PLUGINS_ARTIFACT : BETTER_AUTH_D1_CUTOVER_ARTIFACT
}

export function renderBetterAuthD1WranglerConfig(input: BetterAuthD1WranglerConfigInput) {
  return renderBetterAuthD1WranglerConfigForArtifact(
    input,
    input.mode === "cutover"
      ? betterAuthD1CutoverArtifact(Boolean(input.agentPlugins), Boolean(input.sandbox))
      : BETTER_AUTH_D1_LOCKED_ARTIFACT,
    input.mode === "cutover",
  )
}

export function renderBetterAuthD1LiveSyncMigrationBridgeWranglerConfig(input: BetterAuthD1WranglerConfigInput) {
  return renderBetterAuthD1WranglerConfigForArtifact(input, BETTER_AUTH_D1_LIVE_SYNC_MIGRATION_BRIDGE_ARTIFACT, true)
}

export function betterAuthD1ReleaseSubprocessEnvironment(input: {
  env: NodeJS.ProcessEnv
  release: ReturnType<typeof betterAuthD1ReleaseInputs>
  workerBuildId: string
  platformVersionId: string
  authConfigurationId: string
  wranglerConfig: string
}) {
  const variable = (name: string) => {
    const value = input.release.runtimeVariables.find(([candidate]) => candidate === name)?.[1]
    if (!value) throw new Error(`Better Auth D1 release subprocess is missing ${name}`)
    return value
  }
  return {
    ...input.env,
    CLAXEDO_DEPLOYMENT_ID: variable("CLAXEDO_DEPLOYMENT_ID"),
    CLAXEDO_RECOVERY_EPOCH: variable("CLAXEDO_RECOVERY_EPOCH"),
    CLAXEDO_BROWSER_BUILD_ID: variable("CLAXEDO_BROWSER_BUILD_ID"),
    CLAXEDO_RELAY_BUILD_ID: variable("CLAXEDO_RELAY_BUILD_ID"),
    CLAXEDO_AUTH_D1_DATABASE_ID: input.release.authDatabaseId,
    CLAXEDO_AUTH_D1_DATABASE_NAME: input.release.authDatabaseName,
    CLAXEDO_CONTROL_PLANE_D1_DATABASE_ID: input.release.controlPlaneDatabaseId,
    CLAXEDO_CONTROL_PLANE_D1_DATABASE_NAME: input.release.controlPlaneDatabaseName,
    CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID: input.release.namespaceId,
    BETTER_AUTH_URL: input.release.apiOrigin,
    CLAXEDO_APP_ORIGIN: input.release.authConfiguration.appOrigin,
    CLAXEDO_WORKER_BUILD_ID: input.workerBuildId,
    CLAXEDO_PLATFORM_VERSION_ID: input.platformVersionId,
    CLAXEDO_AUTH_CONFIGURATION_ID: input.authConfigurationId,
    CLAXEDO_WRANGLER_CONFIG: input.wranglerConfig,
  } satisfies NodeJS.ProcessEnv
}

export function workerArtifactBuildId(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

const BROWSER_BUILD_ATTESTATION = "claxedo-browser-build.json"

export async function prepareBrowserArtifactsForWorkers(directory: string) {
  const root = path.resolve(directory)
  await rm(path.join(root, "_redirects"), { force: true })
  const removeSourceMaps = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) await removeSourceMaps(absolute)
      else if (entry.isFile() && entry.name.endsWith(".map")) await rm(absolute)
    }
  }
  await removeSourceMaps(root)
}

export async function browserArtifactBuildId(directory: string) {
  const root = path.resolve(directory)
  const files: string[] = []
  const visit = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error("browser artifacts must not contain symbolic links")
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"))
      else throw new Error("browser artifacts must contain only directories and regular files")
    }
  }
  await visit(root)
  const selected = files.filter((file) => file !== BROWSER_BUILD_ATTESTATION).sort()
  if (selected.length === 0) throw new Error("browser artifact directory is empty")
  const digest = createHash("sha256")
  for (const relative of selected) {
    const bytes = await readFile(path.join(root, relative))
    digest.update(`path:${Buffer.byteLength(relative)}:${relative}\nbytes:${bytes.byteLength}\n`)
    digest.update(bytes)
    digest.update("\n")
  }
  return `sha256:${digest.digest("hex")}`
}

export function betterAuthBrowserWorkerName(environment: BetterAuthD1ReleaseEnvironment) {
  return environment === "staging" ? "claxedo-user-deployed-app-staging" : "claxedo-user-deployed-app"
}

export function renderBetterAuthBrowserWranglerConfig(input: {
  environment: BetterAuthD1ReleaseEnvironment
  browserDirectory: string
}) {
  return `name = ${JSON.stringify(betterAuthBrowserWorkerName(input.environment))}
compatibility_date = "2025-05-01"
workers_dev = false
preview_urls = false

[assets]
directory = ${JSON.stringify(path.resolve(input.browserDirectory))}
not_found_handling = "single-page-application"
html_handling = "auto-trailing-slash"
`
}

export function requireSecretInventory(output: string, requiredSecrets: string[]) {
  const parsed = JSON.parse(output) as Array<{ name?: string }>
  const available = new Set(parsed.map((item) => item.name))
  const missing = requiredSecrets.filter((name) => !available.has(name))
  if (missing.length > 0) throw new Error(`missing remote Worker secrets: ${missing.join(", ")}`)
}

export function isAbsentWorkerProbe(stderr: string) {
  return /has no deployments|not found|worker does not exist/i.test(stderr)
}

export async function verifyBootstrapGate(
  apiOrigin: string,
  options: Readonly<{
    attempts?: number
    intervalMs?: number
    fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    wait?: (milliseconds: number) => Promise<void>
  }> = {},
) {
  const attempts = options.attempts ?? 120
  const intervalMs = options.intervalMs ?? 3_000
  const fetcher = options.fetcher ?? ((input, init) => fetchReleaseProbe(String(input), init))
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  let lastFailure: unknown = new Error("bootstrap gate was not queried")
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(apiOrigin, { signal: AbortSignal.timeout(15_000) })
      const body = (await response.json()) as { error?: { code?: string } }
      if (response.status === 503 && body.error?.code === "deployment_bootstrap") return
      lastFailure = new Error("bootstrap gate returned an unexpected response")
    } catch (error) {
      lastFailure = error
    }
    if (attempt < attempts) await wait(intervalMs)
  }
  throw new Error("bootstrap gate did not become the exact fail-closed production deployment", {
    cause: lastFailure,
  })
}

async function fetchHttpsAddress(url: string, address: string, init: RequestInit) {
  const target = new URL(url)
  if (target.protocol !== "https:") throw new Error("release probes require HTTPS")
  return await new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(
      target,
      {
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string> | undefined,
        lookup: (_hostname, options, callback) => {
          if (typeof options === "object" && options.all) {
            callback(null, [{ address, family: 4 }])
            return
          }
          callback(null, address, 4)
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("error", reject)
        response.on("end", () => {
          const headers = new Headers()
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!)
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
              statusText: response.statusMessage,
              headers,
            }),
          )
        })
      },
    )
    request.setTimeout(15_000, () => request.destroy(new Error("release probe timed out")))
    if (init.signal) {
      if (init.signal.aborted) request.destroy(init.signal.reason)
      else init.signal.addEventListener("abort", () => request.destroy(init.signal?.reason), { once: true })
    }
    request.on("error", reject)
    request.end()
  })
}

export async function fetchReleaseProbe(
  url: string,
  init: RequestInit = {},
  dependencies: Readonly<{
    fetcher?: (input: string, init?: RequestInit) => Promise<Response>
    resolver?: (hostname: string) => Promise<readonly string[]>
    addressFetcher?: (url: string, address: string, init: RequestInit) => Promise<Response>
  }> = {},
) {
  try {
    return await (dependencies.fetcher ?? fetch)(url, init)
  } catch (primaryFailure) {
    const target = new URL(url)
    const addresses = await (dependencies.resolver ?? resolvePublicIpv4)(target.hostname)
    let lastFailure: unknown = primaryFailure
    for (const address of addresses) {
      try {
        return await (dependencies.addressFetcher ?? fetchHttpsAddress)(url, address, init)
      } catch (error) {
        lastFailure = error
      }
    }
    throw new Error("release probe failed through normal and authoritative DNS resolution", {
      cause: lastFailure,
    })
  }
}

export function parseVersionUploadOutput(output: string, workerName: string) {
  const records = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  if (records.some((record) => record.type === "command-failed")) {
    throw new Error("Wrangler reported a failed version upload")
  }
  const uploads = records.filter((record) => record.type === "version-upload")
  const upload = uploads.length === 1 ? uploads[0] : undefined
  if (
    !upload ||
    upload.worker_name !== workerName ||
    typeof upload.version_id !== "string" ||
    !VERSION_ID.test(upload.version_id) ||
    upload.preview_url != null ||
    upload.preview_alias_url != null
  )
    throw new Error("Wrangler version upload output did not identify one private exact Worker version")
  return upload.version_id
}

export type WorkerDeploymentStatus = {
  versions: Array<{ version_id: string; percentage: number }>
}

export function parseDeploymentStatus(output: string): WorkerDeploymentStatus {
  const status = JSON.parse(output) as Partial<WorkerDeploymentStatus>
  if (!Array.isArray(status.versions) || status.versions.length < 1 || status.versions.length > 2) {
    throw new Error("Worker deployment must contain one or two explicit versions")
  }
  const versions = status.versions.map((version) => {
    if (!VERSION_ID.test(version.version_id) || !Number.isFinite(version.percentage)) {
      throw new Error("Worker deployment status contains an invalid version allocation")
    }
    return { version_id: version.version_id, percentage: version.percentage }
  })
  const total = versions.reduce((sum, version) => sum + version.percentage, 0)
  if (Math.abs(total - 100) > 0.0001) throw new Error("Worker deployment traffic does not total 100 percent")
  return { versions }
}

export function requireDeploymentTraffic(
  status: WorkerDeploymentStatus,
  expected: Array<{ versionId: string; percentage: number }>,
) {
  const actual = [...status.versions].sort((left, right) => left.version_id.localeCompare(right.version_id))
  const wanted = [...expected]
    .map(({ versionId, percentage }) => ({ version_id: versionId, percentage }))
    .sort((left, right) => left.version_id.localeCompare(right.version_id))
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error("Worker deployment traffic does not match the exact certified allocation")
  }
}

export function cloudflareVersionOverride(workerName: string, versionId: string) {
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(workerName) || !VERSION_ID.test(versionId)) {
    throw new Error("invalid Worker name or version for a Cloudflare override")
  }
  return `${workerName}="${versionId}"`
}

export function candidateVersionTag(
  releaseSequence: string,
  buildId: string,
  secretBundleId?: string,
  browserBuildId?: string,
  configurationId?: string,
) {
  if (!/^\d+$/.test(releaseSequence) || !/^sha256:[0-9a-f]{64}$/.test(buildId)) {
    throw new Error("candidate version tag requires a release sequence and SHA-256 build identity")
  }
  if (secretBundleId !== undefined && !/^sha256:[0-9a-f]{64}$/.test(secretBundleId)) {
    throw new Error("candidate version tag secret bundle must be a SHA-256 identity")
  }
  if (browserBuildId !== undefined && !/^sha256:[0-9a-f]{64}$/.test(browserBuildId)) {
    throw new Error("candidate version tag browser build must be a SHA-256 identity")
  }
  if (configurationId !== undefined && !/^sha256:[0-9a-f]{64}$/.test(configurationId)) {
    throw new Error("candidate version tag configuration must be a SHA-256 identity")
  }
  const secretSuffix = secretBundleId ? `-${secretBundleId.slice("sha256:".length, "sha256:".length + 12)}` : ""
  const browserSuffix = browserBuildId ? `-${browserBuildId.slice("sha256:".length, "sha256:".length + 12)}` : ""
  const configurationSuffix = configurationId
    ? `-${configurationId.slice("sha256:".length, "sha256:".length + 12)}`
    : ""
  return `claxedo-${releaseSequence}-${buildId.slice("sha256:".length, "sha256:".length + 16)}${secretSuffix}${browserSuffix}${configurationSuffix}`
}

export function candidateConfigurationId(variables: ReadonlyMap<string, string>) {
  const canonical = JSON.stringify([...variables].sort(([left], [right]) => left.localeCompare(right)))
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`
}

export async function resolveReleaseSecretsFile(env: NodeJS.ProcessEnv, requiredSecrets: readonly string[]) {
  const configured = env.CLAXEDO_RELEASE_SECRETS_FILE?.trim()
  if (!configured) return undefined
  const file = path.resolve(configured)
  const metadata = await stat(file)
  if (!metadata.isFile()) throw new Error("CLAXEDO_RELEASE_SECRETS_FILE must be a regular JSON file")
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("CLAXEDO_RELEASE_SECRETS_FILE must not be accessible by group or others")
  }
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CLAXEDO_RELEASE_SECRETS_FILE must contain one JSON object")
  }
  const entries = Object.entries(parsed)
  if (entries.length === 0) throw new Error("CLAXEDO_RELEASE_SECRETS_FILE must contain at least one secret")
  const allowed = new Set(requiredSecrets)
  for (const [name, value] of entries) {
    if (!allowed.has(name)) throw new Error(`CLAXEDO_RELEASE_SECRETS_FILE contains unexpected secret ${name}`)
    if (typeof value !== "string" || !value) {
      throw new Error(`CLAXEDO_RELEASE_SECRETS_FILE secret ${name} must be a non-empty string`)
    }
  }
  const canonical = JSON.stringify(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))))
  return Object.freeze({
    file,
    names: Object.freeze(entries.map(([name]) => name)),
    bundleId: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
  })
}

export function taggedCandidateVersionId(output: string, tag: string) {
  const versions = JSON.parse(output) as Array<{ id?: string; annotations?: Record<string, string> }>
  if (!Array.isArray(versions)) throw new Error("Wrangler versions list did not return an array")
  const matching = versions.filter((version) => version.annotations?.["workers/tag"] === tag)
  if (matching.length === 0) return undefined
  if (matching.length !== 1) throw new Error("candidate version tag resolves to more than one Worker version")
  const versionId = matching[0]?.id
  if (!versionId || !VERSION_ID.test(versionId)) throw new Error("tagged candidate version has an invalid ID")
  return versionId
}

export function recoverCandidateVersion(input: {
  output: string
  tag: string
  expectedVariables: ReadonlyMap<string, string>
  authDatabaseId: string
  controlPlaneDatabaseId: string
  namespaceId: string
}) {
  const versions = JSON.parse(input.output) as Array<{
    id?: string
    annotations?: Record<string, string>
    resources?: { bindings?: Array<Record<string, unknown>> }
  }>
  if (!Array.isArray(versions)) throw new Error("Wrangler versions list did not return an array")
  const matching = versions.filter((version) => version.annotations?.["workers/tag"] === input.tag)
  if (matching.length === 0) return undefined
  if (matching.length !== 1) throw new Error("candidate version tag resolves to more than one Worker version")
  const version = matching[0]!
  if (!version.id || !VERSION_ID.test(version.id) || !Array.isArray(version.resources?.bindings)) {
    throw new Error("tagged candidate version has invalid resource metadata")
  }
  const bindings = version.resources.bindings
  for (const [name, expected] of input.expectedVariables) {
    const found = bindings.find((binding) => binding.type === "plain_text" && binding.name === name)
    if (found?.text !== expected) throw new Error(`tagged candidate version has conflicting ${name}`)
  }
  const authDatabase = bindings.find((binding) => binding.type === "d1" && binding.name === "AUTH_DB")
  if (authDatabase?.id !== input.authDatabaseId) {
    throw new Error("tagged candidate version has a conflicting AUTH_DB binding")
  }
  const controlPlaneDatabase = bindings.find((binding) => binding.type === "d1" && binding.name === "CONTROL_PLANE_DB")
  if (controlPlaneDatabase?.id !== input.controlPlaneDatabaseId) {
    throw new Error("tagged candidate version has a conflicting CONTROL_PLANE_DB binding")
  }
  const limiter = bindings.find((binding) => binding.type === "ratelimit" && binding.name === "CLAXEDO_REQUEST_LIMITER")
  if (limiter?.namespace_id !== input.namespaceId) {
    throw new Error("tagged candidate version has a conflicting rate-limiter namespace")
  }
  if (!bindings.some((binding) => binding.type === "version_metadata" && binding.name === "CF_VERSION_METADATA")) {
    throw new Error("tagged candidate version is missing Cloudflare version metadata")
  }
  if (bindings.some((binding) => /document/i.test(String(binding.name)))) {
    throw new Error("tagged candidate version contains an optional-service binding")
  }
  return version.id
}

export function workerVersionHasLiveSyncRoom(output: string) {
  const version = JSON.parse(output) as { resources?: { bindings?: Array<Record<string, unknown>> } }
  const bindings = version.resources?.bindings
  if (!Array.isArray(bindings)) throw new Error("Worker version omitted resource bindings")
  return bindings.some(
    (binding) =>
      binding.type === "durable_object_namespace" &&
      binding.name === "LIVE_SYNC_ROOM" &&
      binding.class_name === "LiveSyncRoom",
  )
}

async function run(args: string[], options: { capture?: boolean; env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  const executable =
    args[0] === "bun"
      ? process.execPath
      : path.join(serverRoot, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler")
  let output = ""
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const child = spawn(executable, args.slice(1), {
      cwd: options.cwd ?? serverRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", options.capture ? "pipe" : "inherit", "pipe"],
      shell: process.platform === "win32",
    })
    output = ""
    let stderr = ""
    if (options.capture && child.stdout) {
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        output += chunk
      })
    }
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
      process.stderr.write(chunk)
    })
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
    if (code === 0) break
    if (attempt === 5 || !isTransientWranglerFailure(stderr)) {
      throw new Error(`${args.slice(0, 3).join(" ")} failed`)
    }
    const delayMs = attempt * 1_000
    console.warn(`Wrangler connectivity failure; retrying idempotent release command in ${delayMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return output
}

async function probe(args: string[]) {
  const executable = path.join(
    serverRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  )
  const child = spawn(executable, args.slice(1), {
    cwd: serverRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  })
  let stdout = ""
  let stderr = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk
  })
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  return { code, stdout, stderr }
}

async function ensureCutoverLiveSyncLifecycle(input: {
  release: ReturnType<typeof betterAuthD1ReleaseInputs>
  staging: boolean
  temporary: string
  configArgs: string[]
  workerName: string
}) {
  if (input.release.mode !== "cutover") return

  const status = parseDeploymentStatus(
    await run(["wrangler", "deployments", "status", ...input.configArgs, "--json"], { capture: true }),
  )
  if (status.versions.length !== 1) {
    throw new Error("the LiveSyncRoom lifecycle bridge refuses an existing split deployment")
  }
  const incumbentVersionId = status.versions[0]!.version_id
  requireDeploymentTraffic(status, [{ versionId: incumbentVersionId, percentage: 100 }])
  const incumbent = await run(["wrangler", "versions", "view", incumbentVersionId, ...input.configArgs, "--json"], {
    capture: true,
  })
  if (workerVersionHasLiveSyncRoom(incumbent)) return
  if (required(process.env, "CLAXEDO_PREVIOUS_PHASE") !== "locked") {
    throw new Error("the LiveSyncRoom lifecycle bridge is allowed only from a locked predecessor")
  }

  const bridgeConfig = path.join(input.temporary, "live-sync-migration-bridge.wrangler.toml")
  await writeFile(
    bridgeConfig,
    renderBetterAuthD1LiveSyncMigrationBridgeWranglerConfig({
      staging: input.staging,
      ...input.release,
    }),
  )
  const bridgeConfigArgs = ["--config", bridgeConfig]
  await run([
    "wrangler",
    "deploy",
    ...bridgeConfigArgs,
    "--domain",
    new URL(input.release.apiOrigin).hostname,
    "--keep-vars=true",
    "--strict",
    "--tag",
    "claxedo-live-sync-migration-v1",
    "--message",
    `Install LiveSyncRoom v1 fail-closed bridge before ${required(process.env, "CLAXEDO_RELEASE_ID")}`,
    "--tsconfig",
    path.join(serverRoot, "tsconfig.auth-d1.json"),
  ])
  await verifyBootstrapGate(input.release.apiOrigin)

  const installedStatus = parseDeploymentStatus(
    await run(["wrangler", "deployments", "status", ...bridgeConfigArgs, "--json"], { capture: true }),
  )
  if (installedStatus.versions.length !== 1) {
    throw new Error("the LiveSyncRoom lifecycle bridge did not produce one atomic deployment")
  }
  const bridgeVersionId = installedStatus.versions[0]!.version_id
  requireDeploymentTraffic(installedStatus, [{ versionId: bridgeVersionId, percentage: 100 }])
  const bridgeVersion = await run(["wrangler", "versions", "view", bridgeVersionId, ...bridgeConfigArgs, "--json"], {
    capture: true,
  })
  if (!workerVersionHasLiveSyncRoom(bridgeVersion)) {
    throw new Error("the fail-closed bridge did not install the exact LiveSyncRoom namespace")
  }
  console.log(`LiveSyncRoom v1 lifecycle installed through fail-closed bridge ${bridgeVersionId}`)
}

async function verifyHealth(input: {
  apiOrigin: string
  path: "/health" | "/__release/candidate-health"
  workerName: string
  versionId: string
  buildId: string
  releaseId: string
  authConfigurationId: string
  override: boolean
}) {
  let failure: unknown
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetchReleaseProbe(`${input.apiOrigin}${input.path}`, {
        headers: input.override
          ? { "Cloudflare-Workers-Version-Overrides": cloudflareVersionOverride(input.workerName, input.versionId) }
          : undefined,
        signal: AbortSignal.timeout(15_000),
      })
      const body = (await response.json()) as {
        platformVersionId?: string
        release?: { workerBuildId?: string; releaseId?: string; authConfigurationId?: string }
      }
      if (
        response.ok &&
        body.platformVersionId === input.versionId &&
        body.release?.workerBuildId === input.buildId &&
        body.release.releaseId === input.releaseId &&
        body.release.authConfigurationId === input.authConfigurationId
      ) {
        return
      }
      failure = new Error("health response did not match the exact release identity")
    } catch (error) {
      failure = error
    }
    if (attempt < 6) {
      const delayMs = attempt * 1_000
      console.warn(`Worker health has not converged; retrying exact verification in ${delayMs}ms`)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw new Error(`deployed locked Worker failed exact ${input.path} verification`, { cause: failure })
}

async function verifyRestoredIncumbent(apiOrigin: string, versionId: string) {
  const response = await fetchReleaseProbe(`${apiOrigin}/health`, { signal: AbortSignal.timeout(15_000) })
  const body = (await response.json()) as { status?: string; platformVersionId?: string }
  if (!response.ok || body.status !== "locked" || body.platformVersionId !== versionId) {
    throw new Error("restored incumbent did not recover locked health")
  }
}

async function verifyBrowserArtifact(appOrigin: string, browserBuildId: string) {
  const response = await fetchReleaseProbe(`${appOrigin}/${BROWSER_BUILD_ATTESTATION}`, {
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await response.json()) as { browserBuildId?: string }
  if (!response.ok || body.browserBuildId !== browserBuildId) {
    throw new Error("deployed browser did not serve the exact release-bound build identity")
  }
}

async function main() {
  const staging = process.argv.includes("--staging")
  const deploy = process.argv.includes("--deploy")
  const bootstrap = process.argv.includes("--bootstrap")
  const cutover = process.argv.includes("--cutover")
  const agentPlugins = process.argv.includes("--agent-plugins")
  if (agentPlugins && !cutover) throw new Error("--agent-plugins selects the candidate artifact and requires --cutover")
  const environment = staging ? "staging" : "production"
  if (bootstrap && cutover) throw new Error("--bootstrap and --cutover are mutually exclusive")
  const workerName = betterAuthD1WorkerName(environment)
  const appRoot = path.resolve(serverRoot, "../claxedo-app")
  const browserDirectory = path.join(appRoot, "dist-better-auth")
  let browserBuildId: string | undefined
  if (cutover) {
    const apiOrigin = exactHttpsOrigin(process.env, `CLAXEDO_${environment.toUpperCase()}_API_ORIGIN`).origin
    await run(["bun", "run", "build:better-auth"], {
      cwd: appRoot,
      // The browser carries the Agent Plugins UI chunk only in the same build
      // that ships the Worker with the routes, so one flag selects both.
      env: { ...process.env, VITE_CLAXEDO_SERVER_URL: apiOrigin, ...(agentPlugins ? { CLAXEDO_AGENT_PLUGINS: "1" } : {}) },
    })
    await run(["bun", "scripts/browser-auth-bundle-identity.ts", "better-auth", browserDirectory], {
      cwd: appRoot,
    })
    await prepareBrowserArtifactsForWorkers(browserDirectory)
    browserBuildId = await browserArtifactBuildId(browserDirectory)
    await writeFile(
      path.join(browserDirectory, BROWSER_BUILD_ATTESTATION),
      `${JSON.stringify({ schemaVersion: 1, browserBuildId }, null, 2)}\n`,
    )
  }
  const input = betterAuthD1ReleaseInputs(process.env, environment, {
    mode: cutover ? "cutover" : "locked",
    ...(browserBuildId ? { browserBuildId } : {}),
    ...(agentPlugins ? { agentPlugins: true } : {}),
  })
  const authConfigurationId = await betterAuthDeploymentConfigurationId(input.authConfiguration)
  const temporary = await mkdtemp(path.join(serverRoot, ".claxedo-better-auth-release-"))
  try {
    const config = path.join(temporary, "wrangler.toml")
    const bundleDirectory = path.join(temporary, "bundle")
    const bundle = path.join(
      bundleDirectory,
      cutover
        ? input.sandbox
          ? "better-auth-d1-candidate-worker.agent-plugins.full-hosted.cf.js"
          : agentPlugins
            ? "better-auth-d1-candidate-worker.agent-plugins.cf.js"
            : "better-auth-d1-candidate-worker.cf.js"
        : "better-auth-d1-locked-worker.cf.js",
    )
    await writeFile(config, renderBetterAuthD1WranglerConfig({ staging, ...input }))
    const configArgs = ["--config", config]
    const publishBrowser = async () => {
      if (!cutover) return
      const browserConfig = path.join(temporary, "browser-wrangler.toml")
      await writeFile(browserConfig, renderBetterAuthBrowserWranglerConfig({ environment, browserDirectory }))
      await run([
        "wrangler",
        "deploy",
        "--config",
        browserConfig,
        "--domain",
        new URL(input.authConfiguration.appOrigin).hostname,
      ])
      await verifyBrowserArtifact(input.authConfiguration.appOrigin, input.browserBuildId)
    }
    if (bootstrap) {
      if (!deploy) throw new Error("--bootstrap requires --deploy")
      await run(["wrangler", "d1", "info", "AUTH_DB", ...configArgs, "--json"], { capture: true })
      await run(["wrangler", "d1", "info", "CONTROL_PLANE_DB", ...configArgs, "--json"], { capture: true })
      if (required(process.env, "CLAXEDO_BOOTSTRAP_CONFIRM_WORKER_NAME") !== workerName) {
        throw new Error("CLAXEDO_BOOTSTRAP_CONFIRM_WORKER_NAME must exactly name the empty Worker")
      }
      if (
        required(process.env, "CLAXEDO_RELEASE_SEQUENCE") !== "1" ||
        process.env.CLAXEDO_PREVIOUS_RELEASE_ID?.trim()
      ) {
        throw new Error("bootstrap is valid only for the first release with no predecessor")
      }
      const existing = await probe(["wrangler", "deployments", "status", ...configArgs, "--json"])
      if (existing.code === 0) throw new Error("bootstrap refuses to replace a Worker that already has a deployment")
      if (!isAbsentWorkerProbe(existing.stderr)) {
        throw new Error("bootstrap could not prove that the target Worker has no deployment")
      }
      await run([
        "wrangler",
        "deploy",
        certifiedHostedWorkerArtifact(BETTER_AUTH_D1_LOCKED_ARTIFACT, environment).bootstrapEntrypointFromPackageRoot,
        ...configArgs,
        "--domain",
        new URL(input.apiOrigin).hostname,
        "--keep-vars=false",
        "--tag",
        "claxedo-bootstrap-gate-v1",
      ])
      await verifyBootstrapGate(input.apiOrigin)
      console.log(
        "Fail-closed bootstrap gate deployed; install Worker secrets, then run the release without --bootstrap",
      )
      return
    }
    const vars = [...input.runtimeVariables, ["CLAXEDO_AUTH_CONFIGURATION_ID", authConfigurationId] as const].flatMap(
      ([name, value]) => ["--var", `${name}:${value}`],
    )
    await run([
      "wrangler",
      "deploy",
      ...configArgs,
      "--domain",
      new URL(input.apiOrigin).hostname,
      "--keep-vars=false",
      ...vars,
      "--dry-run",
      "--outdir",
      bundleDirectory,
      "--metafile",
      path.join(temporary, "bundle-meta.json"),
      "--tsconfig",
      path.join(serverRoot, "tsconfig.auth-d1.json"),
    ])
    const buildId = workerArtifactBuildId(await readFile(bundle))
    console.log(`certified Worker artifact: ${buildId}`)
    if (!deploy) return
    await run(["wrangler", "d1", "info", "AUTH_DB", ...configArgs, "--json"], { capture: true })
    await run(["wrangler", "d1", "info", "CONTROL_PLANE_DB", ...configArgs, "--json"], { capture: true })
    const secrets = await run(["wrangler", "secret", "list", ...configArgs, "--format", "json"], { capture: true })
    const releaseSecrets = await resolveReleaseSecretsFile(process.env, input.requiredSecrets)
    // A secret the release file carries is uploaded with the tagged version, so
    // it need not already sit on the Worker — provisioning it by hand first
    // would mint an untagged version the candidate gate refuses.
    requireSecretInventory(
      secrets,
      input.requiredSecrets.filter((name) => !releaseSecrets?.names.includes(name)),
    )
    await ensureCutoverLiveSyncLifecycle({
      release: input,
      staging,
      temporary,
      configArgs,
      workerName,
    })
    const candidateVars = [...vars, "--var", `CLAXEDO_WORKER_BUILD_ID:${buildId}`]
    const expectedVariables = new Map<string, string>([
      ...input.runtimeVariables,
      ["CLAXEDO_AUTH_CONFIGURATION_ID", authConfigurationId],
      ["CLAXEDO_WORKER_BUILD_ID", buildId],
    ])
    const tag = candidateVersionTag(
      required(process.env, "CLAXEDO_RELEASE_SEQUENCE"),
      buildId,
      releaseSecrets?.bundleId,
      input.mode === "cutover" ? input.browserBuildId : undefined,
      candidateConfigurationId(expectedVariables),
    )
    const versions = await run(["wrangler", "versions", "list", ...configArgs, "--json"], { capture: true })
    const taggedVersionId = taggedCandidateVersionId(versions, tag)
    let platformVersionId: string | undefined
    if (taggedVersionId) {
      const version = await run(["wrangler", "versions", "view", taggedVersionId, ...configArgs, "--json"], {
        capture: true,
      })
      platformVersionId = recoverCandidateVersion({
        output: JSON.stringify([JSON.parse(version)]),
        tag,
        expectedVariables,
        authDatabaseId: input.authDatabaseId,
        controlPlaneDatabaseId: input.controlPlaneDatabaseId,
        namespaceId: input.namespaceId,
      })
    }
    if (!platformVersionId) {
      const uploadOutput = path.join(temporary, "version-upload.ndjson")
      await run(
        [
          "wrangler",
          "versions",
          "upload",
          bundle,
          "--no-bundle",
          ...configArgs,
          "--keep-vars=false",
          "--strict",
          ...candidateVars,
          ...(releaseSecrets ? ["--secrets-file", releaseSecrets.file] : []),
          "--tag",
          tag,
          "--message",
          `Claxedo ${input.mode} release ${required(process.env, "CLAXEDO_RELEASE_ID")} (${buildId})`,
        ],
        { env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: uploadOutput } },
      )
      platformVersionId = parseVersionUploadOutput(await readFile(uploadOutput, "utf8"), workerName)
    }
    const releaseEnv = betterAuthD1ReleaseSubprocessEnvironment({
      env: process.env,
      release: input,
      workerBuildId: buildId,
      platformVersionId,
      authConfigurationId,
      wranglerConfig: config,
    })
    await run(
      [
        "bun",
        "run",
        "scripts/deploy/prepare-better-auth-d1.ts",
        "--register-candidate",
        ...(staging ? ["--staging"] : []),
      ],
      { env: releaseEnv },
    )
    const deploymentManifestPath = betterAuthD1DeploymentManifestPath(process.env, environment)
    await mkdir(path.dirname(deploymentManifestPath), { recursive: true })
    await writeFile(
      deploymentManifestPath,
      `${JSON.stringify(
        betterAuthD1DeploymentManifest({
          release: input,
          workerBuildId: buildId,
          platformVersionId,
          authConfigurationId,
        }),
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
    console.log(`deployment manifest: ${deploymentManifestPath}`)
    let status = parseDeploymentStatus(
      await run(["wrangler", "deployments", "status", ...configArgs, "--json"], { capture: true }),
    )
    const candidateAllocation = status.versions.find((version) => version.version_id === platformVersionId)
    let incumbentVersionId: string
    if (status.versions.length === 1 && candidateAllocation?.percentage === 100) {
      incumbentVersionId = platformVersionId
    } else if (status.versions.length === 1 && status.versions[0]?.percentage === 100) {
      incumbentVersionId = status.versions[0].version_id
      await run([
        "wrangler",
        "versions",
        "deploy",
        `${incumbentVersionId}@100%`,
        `${platformVersionId}@0%`,
        ...configArgs,
        "-y",
        "--message",
        `Smoke ${required(process.env, "CLAXEDO_RELEASE_ID")}`,
      ])
      status = parseDeploymentStatus(
        await run(["wrangler", "deployments", "status", ...configArgs, "--json"], { capture: true }),
      )
      requireDeploymentTraffic(status, [
        { versionId: incumbentVersionId, percentage: 100 },
        { versionId: platformVersionId, percentage: 0 },
      ])
    } else if (status.versions.length === 2 && candidateAllocation?.percentage === 0) {
      const incumbent = status.versions.find((version) => version.version_id !== platformVersionId)
      if (!incumbent || incumbent.percentage !== 100) {
        throw new Error("release refuses an unexpected candidate traffic split")
      }
      incumbentVersionId = incumbent.version_id
    } else {
      throw new Error("release refuses a pre-existing split or unknown candidate allocation")
    }
    const health = {
      apiOrigin: input.apiOrigin,
      workerName,
      versionId: platformVersionId,
      buildId,
      releaseId: required(process.env, "CLAXEDO_RELEASE_ID"),
      authConfigurationId,
    }
    if (incumbentVersionId !== platformVersionId) {
      await verifyHealth({ ...health, path: "/__release/candidate-health", override: true })
    }
    await run(
      [
        "bun",
        "run",
        "scripts/deploy/prepare-better-auth-d1.ts",
        "--activate-candidate",
        ...(staging ? ["--staging"] : []),
      ],
      { env: releaseEnv },
    )
    await verifyHealth({ ...health, path: "/health", override: incumbentVersionId !== platformVersionId })
    if (incumbentVersionId === platformVersionId) {
      requireDeploymentTraffic(status, [{ versionId: platformVersionId, percentage: 100 }])
      await publishBrowser()
      console.log(`Better Auth D1 ${input.mode} release recovered and verified`)
      return
    }
    try {
      await run([
        "wrangler",
        "versions",
        "deploy",
        `${platformVersionId}@100%`,
        ...configArgs,
        "-y",
        "--message",
        `Promote ${required(process.env, "CLAXEDO_RELEASE_ID")}`,
      ])
    } catch (promotionError) {
      const observed = parseDeploymentStatus(
        await run(["wrangler", "deployments", "status", ...configArgs, "--json"], { capture: true }),
      )
      try {
        requireDeploymentTraffic(observed, [{ versionId: platformVersionId, percentage: 100 }])
        status = observed
      } catch {
        requireDeploymentTraffic(observed, [
          { versionId: incumbentVersionId, percentage: 100 },
          { versionId: platformVersionId, percentage: 0 },
        ])
        if (!process.env.CLAXEDO_PREVIOUS_RELEASE_ID?.trim()) throw promotionError
        const candidateOperationId = required(process.env, "CLAXEDO_RELEASE_OPERATION_ID")
        const rollbackOperationId = `rollback:${createHash("sha256").update(candidateOperationId).digest("hex")}`
        await run(
          [
            "bun",
            "run",
            "scripts/deploy/prepare-better-auth-d1.ts",
            "--rollback-candidate",
            ...(staging ? ["--staging"] : []),
          ],
          { env: { ...releaseEnv, CLAXEDO_ROLLBACK_OPERATION_ID: rollbackOperationId } },
        )
        status = parseDeploymentStatus(
          await run(["wrangler", "deployments", "status", ...configArgs, "--json"], { capture: true }),
        )
        requireDeploymentTraffic(status, [
          { versionId: incumbentVersionId, percentage: 100 },
          { versionId: platformVersionId, percentage: 0 },
        ])
        await verifyRestoredIncumbent(input.apiOrigin, incumbentVersionId)
        throw new Error("candidate promotion failed; D1 was rolled back to the healthy incumbent", {
          cause: promotionError,
        })
      }
    }
    status = parseDeploymentStatus(
      await run(["wrangler", "deployments", "status", ...configArgs, "--json"], { capture: true }),
    )
    requireDeploymentTraffic(status, [{ versionId: platformVersionId, percentage: 100 }])
    await verifyHealth({ ...health, path: "/health", override: false })
    await publishBrowser()
    console.log(`Better Auth D1 ${input.mode} release deployed and verified`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) await main()
