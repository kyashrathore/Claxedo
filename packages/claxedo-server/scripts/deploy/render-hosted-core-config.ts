import {
  certifiedHostedWorkerArtifact,
  type CertifiedHostedWorkerArtifactId,
} from "../../src/deployments/hosted-workerd/certified-worker-artifacts"

export type RateLimitNamespaceAllocation = Readonly<{
  owner: string
  environment: "production" | "staging"
  namespaceId: string
}>

export type HostedCoreConfigInput = Readonly<{
  artifactId: CertifiedHostedWorkerArtifactId
  deploymentId: string
  limiter: RateLimitNamespaceAllocation
  authDatabase: Readonly<{ name: string; id: string }>
  controlPlaneDatabase: Readonly<{ name: string; id: string }>
  userDeployedOrganization?: Readonly<{ id: string; name: string }>
}>

const INPUT_KEYS = new Set([
  "artifactId",
  "deploymentId",
  "limiter",
  "authDatabase",
  "controlPlaneDatabase",
  "userDeployedOrganization",
])

function requireExactInput(input: HostedCoreConfigInput) {
  const unexpected = Object.keys(input).filter((key) => !INPUT_KEYS.has(key))
  if (unexpected.length > 0) {
    throw new Error(`hosted core config contains unsupported fields: ${unexpected.sort().join(", ")}`)
  }
}

function quote(value: string) {
  if (!value || value.trim() !== value) throw new Error("Wrangler identifiers must be non-empty trimmed strings")
  return JSON.stringify(value)
}

function positiveNamespaceId(value: string) {
  if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new Error("rate-limit namespace IDs must be positive safe integers")
  }
  return value
}

export function requireUniqueRateLimitNamespaces(allocations: readonly RateLimitNamespaceAllocation[]) {
  const ownerByNamespace = new Map<string, string>()
  for (const allocation of allocations) {
    const namespaceId = positiveNamespaceId(allocation.namespaceId)
    const owner = `${allocation.owner}:${allocation.environment}`
    const existing = ownerByNamespace.get(namespaceId)
    if (existing) throw new Error(`rate-limit namespace ${namespaceId} is reused by ${existing} and ${owner}`)
    ownerByNamespace.set(namespaceId, owner)
  }
}

export function renderHostedCoreWranglerConfig(input: HostedCoreConfigInput) {
  requireExactInput(input)
  requireUniqueRateLimitNamespaces([input.limiter])
  const artifact = certifiedHostedWorkerArtifact(input.artifactId, input.limiter.environment)
  if (input.limiter.owner !== "core") throw new Error("the core config requires a core-owned limiter namespace")
  if (artifact.resources.liveSyncRoom && !input.userDeployedOrganization) {
    throw new Error("the open user-deployed core requires its one organization identity")
  }
  if (!artifact.resources.liveSyncRoom && input.userDeployedOrganization) {
    throw new Error("the locked artifact must not receive open-product organization configuration")
  }
  const productVariables = input.userDeployedOrganization
    ? `
CLAXEDO_ENVIRONMENT_ID = ${quote(input.limiter.environment)}
CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID = ${quote(input.userDeployedOrganization.id)}
CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME = ${quote(input.userDeployedOrganization.name)}\n`
    : ""
  const liveSyncResources = artifact.resources.liveSyncRoom
    ? `
[[durable_objects.bindings]]
name = "LIVE_SYNC_ROOM"
class_name = "LiveSyncRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["LiveSyncRoom"]
`
    : ""
  return `name = ${quote(artifact.workerName)}
main = ${quote(artifact.entrypointFromPackageRoot)}
compatibility_date = "2025-05-01"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
workers_dev = false
preview_urls = false

[version_metadata]
binding = "CF_VERSION_METADATA"

[observability]
enabled = true

[vars]
CLAXEDO_ADAPTER_PROFILE = ${quote(artifact.adapterProfile)}
CLAXEDO_PRODUCT_POSTURE = ${quote(artifact.productPosture)}
CLAXEDO_SANDBOX_POSTURE = ${quote(artifact.sandboxPosture)}
CLAXEDO_DEPLOYMENT_ID = ${quote(input.deploymentId)}
CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID = ${quote(input.limiter.namespaceId)}
${productVariables}

[[d1_databases]]
binding = "AUTH_DB"
database_name = ${quote(input.authDatabase.name)}
database_id = ${quote(input.authDatabase.id)}
migrations_dir = "migrations/auth"

[[d1_databases]]
binding = "CONTROL_PLANE_DB"
database_name = ${quote(input.controlPlaneDatabase.name)}
database_id = ${quote(input.controlPlaneDatabase.id)}
migrations_dir = "migrations/control-plane"

[[ratelimits]]
name = "CLAXEDO_REQUEST_LIMITER"
namespace_id = ${quote(positiveNamespaceId(input.limiter.namespaceId))}
[ratelimits.simple]
limit = 600
period = 60
${liveSyncResources}
`
}
