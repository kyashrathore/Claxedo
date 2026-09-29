import path from "node:path"

import type { CertifiedHostedWorkerArtifact } from "../../src/deployments/hosted-workerd/certified-worker-artifacts"
import { HOSTED_WORKER_BUNDLE_CONTRACT } from "./hosted-worker-bundle"

const SERVER_ROOT = path.resolve(import.meta.dirname, "../..")

export type WorkerWranglerConfigInput = Readonly<{
  workerName: string
  artifact: CertifiedHostedWorkerArtifact
  /** Absolute directory the config is written to; every path below is resolved from it. */
  configDirectory: string
  authDatabase: Readonly<{ name: string; id: string }>
  controlPlaneDatabase: Readonly<{ name: string; id: string }>
  /** `migrations_dir` for CONTROL_PLANE_DB relative to `configDirectory`, as `stageWorkerControlPlaneMigrations` answers it. */
  controlPlaneMigrationsDir: string
  requestLimiterNamespaceId: string
  agentPluginsBucket?: string
  variables: Readonly<Record<string, string>>
}>

function quote(value: string) {
  if (!value || value.trim() !== value) throw new Error("Wrangler values must be non-empty trimmed strings")
  return JSON.stringify(value)
}

function fromConfig(configDirectory: string, packagePath: string) {
  return path.relative(configDirectory, path.join(SERVER_ROOT, packagePath)).split(path.sep).join("/")
}

function positiveNamespaceId(value: string) {
  if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new Error("rate-limit namespace IDs must be positive safe integers")
  }
  return value
}

/** The one Wrangler config every user-deployed Worker publish, dry run and local harness renders. */
export function renderWorkerWranglerConfig(input: WorkerWranglerConfigInput) {
  if (input.artifact.agentPlugins !== Boolean(input.agentPluginsBucket)) {
    throw new Error("the Agent Plugins artifacts, and only they, bind the plugin artifact bucket")
  }
  const variables = Object.entries(input.variables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name} = ${quote(value)}`)
    .join("\n")
  const agentPluginsBucket = input.agentPluginsBucket
    ? `
[[r2_buckets]]
binding = "CLAXEDO_AGENT_PLUGINS"
bucket_name = ${quote(input.agentPluginsBucket)}
`
    : ""
  return `name = ${quote(input.workerName)}
main = ${quote(fromConfig(input.configDirectory, input.artifact.entrypointFromPackageRoot))}
${HOSTED_WORKER_BUNDLE_CONTRACT}

[version_metadata]
binding = "CF_VERSION_METADATA"

[observability]
enabled = true

# Run beside the data. Every request performs several sequential D1 reads
# (session, then the route's own) and the plugin routes read R2; with the
# databases and bucket in APAC and the isolate at the caller's colo, each
# await was a cross-region hop and a signed catalog read measured 4 s with
# under 100 ms of CPU.
[placement]
mode = "smart"

[vars]
${variables}

[[d1_databases]]
binding = "AUTH_DB"
database_name = ${quote(input.authDatabase.name)}
database_id = ${quote(input.authDatabase.id)}
migrations_dir = ${quote(fromConfig(input.configDirectory, "migrations/auth"))}

[[d1_databases]]
binding = "CONTROL_PLANE_DB"
database_name = ${quote(input.controlPlaneDatabase.name)}
database_id = ${quote(input.controlPlaneDatabase.id)}
migrations_dir = ${quote(input.controlPlaneMigrationsDir)}

[[ratelimits]]
name = "CLAXEDO_REQUEST_LIMITER"
namespace_id = ${quote(positiveNamespaceId(input.requestLimiterNamespaceId))}
[ratelimits.simple]
limit = 600
period = 60

[[durable_objects.bindings]]
name = "LIVE_SYNC_ROOM"
class_name = "LiveSyncRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["LiveSyncRoom"]
${agentPluginsBucket}`
}

/** The static-assets Worker that serves the browser app on its own custom domain. */
export function renderAppWranglerConfig(input: Readonly<{ appWorkerName: string; browserDirectory: string }>) {
  return `name = ${quote(input.appWorkerName)}
compatibility_date = "2025-05-01"
workers_dev = false
preview_urls = false

[assets]
directory = ${quote(path.resolve(input.browserDirectory))}
not_found_handling = "single-page-application"
html_handling = "auto-trailing-slash"
`
}
