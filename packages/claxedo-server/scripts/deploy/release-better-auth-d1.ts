import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

const serverRoot = path.resolve(import.meta.dirname, "../..")
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BETTER_AUTH_D1_RELEASE_ARTIFACT = "user-deployed-better-auth-d1-locked" as const

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

export function betterAuthD1WorkerName(environment: BetterAuthD1ReleaseEnvironment) {
  return certifiedHostedWorkerArtifact(BETTER_AUTH_D1_RELEASE_ARTIFACT, environment).workerName
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
    sandboxPosture: "control-plane-only" as const,
    workerBuildId: input.workerBuildId,
    platformVersionId: input.platformVersionId,
    browserBuildId: LOCKED_BROWSER_BUILD_ID,
    relayBuildId: LOCKED_RELAY_BUILD_ID,
    authConfigurationId: input.authConfigurationId,
    serviceManifestId: LOCKED_SERVICE_MANIFEST_ID,
    recoveryEpoch: variable("CLAXEDO_RECOVERY_EPOCH"),
    apiOrigin: input.release.apiOrigin,
    appOrigin: input.release.authConfiguration.appOrigin,
    authMethods: Object.freeze([...input.release.authConfiguration.methods].sort()),
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

export function betterAuthD1ReleaseInputs(env: NodeJS.ProcessEnv, environment: BetterAuthD1ReleaseEnvironment) {
  const profile = resolveDeploymentProfileFromEnv(env)
  if (
    profile.adapterProfile !== "better-auth-d1" ||
    profile.productPosture !== "user-deployed" ||
    profile.sandboxPosture !== "control-plane-only"
  )
    throw new Error("Better Auth D1 release supports only user-deployed control-plane-only")
  if (env.CLAXEDO_WORKER_BUILD_ID?.trim()) {
    throw new Error("CLAXEDO_WORKER_BUILD_ID is derived from the emitted Worker and must not be supplied")
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
    throw new Error("open roll-forward requires the versioned candidate traffic-switch deployer")
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
  const candidateStateRevision = previousStateRevision === undefined ? 0 : previousStateRevision + 1
  const candidateOperationId =
    previousStateRevision === undefined ? `initialize:${releaseId}` : required(env, "CLAXEDO_RELEASE_OPERATION_ID")
  const appOriginName = `CLAXEDO_${environment.toUpperCase()}_APP_ORIGIN`
  const appOrigin = exactHttpsOrigin(env, appOriginName).origin
  return {
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
      ...methods.map((method) => (method === "google" ? "GOOGLE_CLIENT_SECRET" : "GITHUB_CLIENT_SECRET")),
    ],
    runtimeVariables: [
      ["CLAXEDO_DEPLOYMENT_ID", deploymentId],
      ["CLAXEDO_RELEASE_SEQUENCE", positiveInteger(env, "CLAXEDO_RELEASE_SEQUENCE")],
      ["CLAXEDO_RELEASE_ID", releaseId],
      ["CLAXEDO_CANDIDATE_STATE_REVISION", String(candidateStateRevision)],
      ["CLAXEDO_CANDIDATE_OPERATION_ID", candidateOperationId],
      ["CLAXEDO_AUTH_METHODS", methods.join(",")],
      ["CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID", namespaceId],
      ["CLAXEDO_RECOVERY_EPOCH", recoveryEpoch],
      ["BETTER_AUTH_URL", apiOrigin.origin],
      ["CLAXEDO_APP_ORIGIN", appOrigin],
      ...publicProviderVariables,
    ] as Array<readonly [string, string]>,
  }
}

export function renderBetterAuthD1WranglerConfig(input: {
  staging: boolean
  authDatabaseId: string
  authDatabaseName: string
  controlPlaneDatabaseId: string
  controlPlaneDatabaseName: string
  namespaceId: string
}) {
  const quote = (value: string) => JSON.stringify(value)
  const artifact = certifiedHostedWorkerArtifact(
    BETTER_AUTH_D1_RELEASE_ARTIFACT,
    input.staging ? "staging" : "production",
  )
  return `name = ${quote(artifact.workerName)}
main = ${quote(artifact.entrypointFromPackageChild)}
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
CLAXEDO_SANDBOX_POSTURE = "control-plane-only"

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
`
}

export function workerArtifactBuildId(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

export function requireSecretInventory(output: string, requiredSecrets: string[]) {
  const parsed = JSON.parse(output) as Array<{ name?: string }>
  const available = new Set(parsed.map((item) => item.name))
  const missing = requiredSecrets.filter((name) => !available.has(name))
  if (missing.length > 0) throw new Error(`missing remote Worker secrets: ${missing.join(", ")}`)
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

export function candidateVersionTag(releaseSequence: string, buildId: string) {
  if (!/^\d+$/.test(releaseSequence) || !/^sha256:[0-9a-f]{64}$/.test(buildId)) {
    throw new Error("candidate version tag requires a release sequence and SHA-256 build identity")
  }
  return `claxedo-${releaseSequence}-${buildId.slice("sha256:".length, "sha256:".length + 16)}`
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
  if (bindings.some((binding) => /workgraph|document/i.test(String(binding.name)))) {
    throw new Error("tagged candidate version contains an optional-service binding")
  }
  return version.id
}

async function run(args: string[], options: { capture?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const executable =
    args[0] === "bun"
      ? process.execPath
      : path.join(serverRoot, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler")
  const child = spawn(executable, args.slice(1), {
    cwd: serverRoot,
    env: options.env ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32",
  })
  let output = ""
  if (options.capture && child.stdout) {
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      output += chunk
    })
  }
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  if (code !== 0) throw new Error(`${args.slice(0, 3).join(" ")} failed`)
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
  const response = await fetch(`${input.apiOrigin}${input.path}`, {
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
    !response.ok ||
    body.platformVersionId !== input.versionId ||
    body.release?.workerBuildId !== input.buildId ||
    body.release.releaseId !== input.releaseId ||
    body.release.authConfigurationId !== input.authConfigurationId
  ) {
    throw new Error(`deployed locked Worker failed exact ${input.path} verification`)
  }
}

async function verifyRestoredIncumbent(apiOrigin: string, versionId: string) {
  const response = await fetch(`${apiOrigin}/health`, { signal: AbortSignal.timeout(15_000) })
  const body = (await response.json()) as { status?: string; platformVersionId?: string }
  if (!response.ok || body.status !== "locked" || body.platformVersionId !== versionId) {
    throw new Error("restored incumbent did not recover locked health")
  }
}

async function main() {
  const staging = process.argv.includes("--staging")
  const deploy = process.argv.includes("--deploy")
  const bootstrap = process.argv.includes("--bootstrap")
  const environment = staging ? "staging" : "production"
  const workerName = betterAuthD1WorkerName(environment)
  const input = betterAuthD1ReleaseInputs(process.env, environment)
  const authConfigurationId = await betterAuthDeploymentConfigurationId(input.authConfiguration)
  const temporary = await mkdtemp(path.join(serverRoot, ".claxedo-locked-release-"))
  try {
    const config = path.join(temporary, "wrangler.toml")
    const bundleDirectory = path.join(temporary, "bundle")
    const bundle = path.join(bundleDirectory, "better-auth-d1-locked-worker.cf.js")
    await writeFile(config, renderBetterAuthD1WranglerConfig({ staging, ...input }))
    const configArgs = ["--config", config]
    await run(["wrangler", "d1", "info", "AUTH_DB", ...configArgs, "--json"], { capture: true })
    await run(["wrangler", "d1", "info", "CONTROL_PLANE_DB", ...configArgs, "--json"], { capture: true })
    if (bootstrap) {
      if (!deploy) throw new Error("--bootstrap requires --deploy")
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
      if (!/has no deployments|not found/i.test(existing.stderr)) {
        throw new Error("bootstrap could not prove that the target Worker has no deployment")
      }
      await run([
        "wrangler",
        "deploy",
        certifiedHostedWorkerArtifact(BETTER_AUTH_D1_RELEASE_ARTIFACT, environment).bootstrapEntrypointFromPackageRoot,
        ...configArgs,
        "--domain",
        new URL(input.apiOrigin).hostname,
        "--keep-vars=false",
        "--tag",
        "claxedo-bootstrap-gate-v1",
      ])
      const response = await fetch(input.apiOrigin, { signal: AbortSignal.timeout(15_000) })
      const body = (await response.json()) as { error?: { code?: string } }
      if (response.status !== 503 || body.error?.code !== "deployment_bootstrap") {
        throw new Error("bootstrap gate did not become the exact fail-closed production deployment")
      }
      console.log(
        "Fail-closed bootstrap gate deployed; install Worker secrets, then run the release without --bootstrap",
      )
      return
    }
    const secrets = await run(["wrangler", "secret", "list", ...configArgs, "--format", "json"], { capture: true })
    requireSecretInventory(secrets, input.requiredSecrets)
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
    const candidateVars = [...vars, "--var", `CLAXEDO_WORKER_BUILD_ID:${buildId}`]
    const tag = candidateVersionTag(required(process.env, "CLAXEDO_RELEASE_SEQUENCE"), buildId)
    const expectedVariables = new Map<string, string>([
      ...input.runtimeVariables,
      ["CLAXEDO_AUTH_CONFIGURATION_ID", authConfigurationId],
      ["CLAXEDO_WORKER_BUILD_ID", buildId],
    ])
    const versions = await run(["wrangler", "versions", "list", ...configArgs, "--json"], { capture: true })
    let platformVersionId = recoverCandidateVersion({
      output: versions,
      tag,
      expectedVariables,
      authDatabaseId: input.authDatabaseId,
      controlPlaneDatabaseId: input.controlPlaneDatabaseId,
      namespaceId: input.namespaceId,
    })
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
          "--tag",
          tag,
          "--message",
          `Claxedo locked release ${required(process.env, "CLAXEDO_RELEASE_ID")} (${buildId})`,
        ],
        { env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: uploadOutput } },
      )
      platformVersionId = parseVersionUploadOutput(await readFile(uploadOutput, "utf8"), workerName)
    }
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
    const releaseEnv = {
      ...process.env,
      CLAXEDO_DEPLOYMENT_ID: input.runtimeVariables.find(([name]) => name === "CLAXEDO_DEPLOYMENT_ID")?.[1],
      CLAXEDO_AUTH_D1_DATABASE_ID: input.authDatabaseId,
      CLAXEDO_AUTH_D1_DATABASE_NAME: input.authDatabaseName,
      CLAXEDO_CONTROL_PLANE_D1_DATABASE_ID: input.controlPlaneDatabaseId,
      CLAXEDO_CONTROL_PLANE_D1_DATABASE_NAME: input.controlPlaneDatabaseName,
      CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID: input.namespaceId,
      BETTER_AUTH_URL: input.apiOrigin,
      CLAXEDO_APP_ORIGIN: input.authConfiguration.appOrigin,
      CLAXEDO_WORKER_BUILD_ID: buildId,
      CLAXEDO_PLATFORM_VERSION_ID: platformVersionId,
      CLAXEDO_AUTH_CONFIGURATION_ID: authConfigurationId,
      CLAXEDO_WRANGLER_CONFIG: config,
    }
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
      console.log("Better Auth D1 locked release recovered and verified")
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
    console.log("Better Auth D1 locked release deployed and verified")
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) await main()
