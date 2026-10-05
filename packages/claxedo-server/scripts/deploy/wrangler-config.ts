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
  documentsBucket: string
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

[[worker_loaders]]
binding = "PLUGIN_LOADER"
`
    : ""
  // Durable Object migrations are append-only per Worker name: once a Worker
  // has applied v2 it cannot deploy the base artifact, which lacks the class,
  // without a `deleted_classes` migration written for that purpose.
  const pluginSupervisor = input.artifact.agentPlugins
    ? {
        binding: `
[[durable_objects.bindings]]
name = "PLUGIN_SUPERVISOR"
class_name = "PluginSupervisor"
`,
        migration: `
[[migrations]]
tag = "v2"
new_sqlite_classes = ["PluginSupervisor"]
`,
      }
    : { binding: "", migration: "" }
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

[[r2_buckets]]
binding = "CLAXEDO_DOCUMENTS"
bucket_name = ${quote(input.documentsBucket)}

[[send_email]]
name = "EMAIL"

[[ratelimits]]
name = "CLAXEDO_REQUEST_LIMITER"
namespace_id = ${quote(positiveNamespaceId(input.requestLimiterNamespaceId))}
[ratelimits.simple]
limit = 600
period = 60

[[durable_objects.bindings]]
name = "LIVE_SYNC_ROOM"
class_name = "LiveSyncRoom"
${pluginSupervisor.binding}
[[migrations]]
tag = "v1"
new_sqlite_classes = ["LiveSyncRoom"]
${pluginSupervisor.migration}${agentPluginsBucket}`
}

/**
 * The session-host Worker: one `SessionDO` per top-level Pi session, which the
 * relay binds by this Worker's name and which reaches the control plane over
 * a service binding, so it is published after the control-plane Worker.
 */
export function renderSessionHostWranglerConfig(input: Readonly<{
  workerName: string
  controlPlaneWorkerName: string
  configDirectory: string
  variables: Readonly<Record<string, string>>
}>) {
  const main = path.relative(input.configDirectory, path.resolve(SERVER_ROOT, "../session-host/src/worker.ts")).split(path.sep).join("/")
  const variables = Object.entries(input.variables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name} = ${quote(value)}`)
    .join("\n")
  return `name = ${quote(input.workerName)}
main = ${quote(main)}
compatibility_date = "2026-07-22"
compatibility_flags = ["nodejs_compat"]
workers_dev = false
preview_urls = false

[observability]
enabled = true

[vars]
${variables}

[[services]]
binding = "CONTROL_PLANE"
service = ${quote(input.controlPlaneWorkerName)}

[[durable_objects.bindings]]
name = "SESSION_HOST"
class_name = "SessionDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["SessionDO"]
`
}

export const APP_ASSETS_WORKER = path.join(SERVER_ROOT, "scripts/deploy/app-assets-worker.ts")

/** The static-assets Worker that serves the browser app on its own custom domain; its script answers only `/assets/*`. */
export function renderAppWranglerConfig(input: Readonly<{ appWorkerName: string; browserDirectory: string }>) {
  return `name = ${quote(input.appWorkerName)}
main = ${quote(APP_ASSETS_WORKER)}
compatibility_date = "2025-05-01"
workers_dev = false
preview_urls = false

[assets]
directory = ${quote(path.resolve(input.browserDirectory))}
binding = "ASSETS"
not_found_handling = "single-page-application"
html_handling = "auto-trailing-slash"
run_worker_first = ["/assets/*"]
`
}
