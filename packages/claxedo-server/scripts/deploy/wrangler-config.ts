import path from "node:path"

import type { CertifiedHostedWorkerArtifact } from "../../src/deployments/hosted-workerd/certified-worker-artifacts"
import { HOSTED_WORKER_BUNDLE_CONTRACT } from "./hosted-worker-bundle"
import { controlPlaneRoutePatterns } from "./public-origin"

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
  /** The writer's cloud region in Wrangler's `placement.region` form; absent, its placement is smart. */
  placementRegion?: string
  /** The public origin's hostname, the app Worker's custom domain, on which the control plane's paths become its routes. */
  publicOriginHost: string
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

type DurableObjectBinding = { name: string; className: string; tag: string }

/** The Durable Object classes the artifact defines, each with the append-only migration tag that introduced it. */
function durableObjects(artifact: CertifiedHostedWorkerArtifact): DurableObjectBinding[] {
  // Durable Object migrations are append-only per Worker name: once a Worker
  // has applied v2 it cannot deploy the base artifact, which lacks the class,
  // without a `deleted_classes` migration written for that purpose; v3 holds
  // a full-hosted Worker to the full-hosted artifact the same way.
  return [
    { name: "LIVE_SYNC_ROOM", className: "LiveSyncRoom", tag: "v1" },
    ...(artifact.agentPlugins ? [{ name: "PLUGIN_SUPERVISOR", className: "PluginSupervisor", tag: "v2" }] : []),
    ...(artifact.sandboxPosture === "full-hosted" ? [{ name: "SANDBOX_PROVISIONER", className: "SandboxProvisioner", tag: "v3" }] : []),
  ]
}

/** Everything both control-plane Workers bind the same way: version metadata, variables, databases, buckets, email and the shared limiter. */
function sharedWorkerConfig(input: WorkerWranglerConfigInput) {
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
  return `[version_metadata]
binding = "CF_VERSION_METADATA"

[observability]
enabled = true

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
${agentPluginsBucket}`
}

/**
 * The control plane's writer: the Worker every request that may write runs
 * on, beside the databases' primary, and the one that defines the Durable
 * Object classes, so it keeps the name their namespaces and the session
 * host's binding were created under. It has no route of its own; the edge
 * Worker and the session host reach it over service bindings.
 */
export function renderWorkerWranglerConfig(input: WorkerWranglerConfigInput) {
  const objects = durableObjects(input.artifact)
  return `name = ${quote(input.workerName)}
main = ${quote(fromConfig(input.configDirectory, input.artifact.entrypointFromPackageRoot))}
${HOSTED_WORKER_BUNDLE_CONTRACT}

# A signed write performs several sequential D1 rounds, each a cross-region
# round trip when the isolate runs away from the primary: from Singapore one
# round costs ~230 ms against ~40 ms beside it. Placement "only affects the
# execution of fetch event handlers" (developers.cloudflare.com/workers/
# configuration/placement/), which is how the edge Worker's service binding
# and the session host's reach this Worker. Smart placement weighs fetch
# subrequests from enough traffic, not D1, so a deployment pins the region.
[placement]
${input.placementRegion ? `region = ${quote(input.placementRegion)}` : 'mode = "smart"'}

${sharedWorkerConfig(input)}${objects.map((object) => `
[[durable_objects.bindings]]
name = ${quote(object.name)}
class_name = ${quote(object.className)}
`).join("")}${objects.map((object) => `
[[migrations]]
tag = ${quote(object.tag)}
new_sqlite_classes = [${quote(object.className)}]
`).join("")}`
}

/**
 * The control plane's edge: the same bundle with no placement, so it runs
 * "in a data center closest to where the request was received"
 * (developers.cloudflare.com/workers/configuration/placement/). It holds the
 * control plane's routes on the public origin's host, answers the reads a
 * client carries D1 bookmarks for from the nearest read replica, and hands
 * every other request to the writer over `CONTROL_PLANE_WRITER`. It reaches
 * the writer's Durable Objects by script name and defines none.
 */
export function renderEdgeWorkerWranglerConfig(input: WorkerWranglerConfigInput & { edgeWorkerName: string }) {
  // Simple routes: Wrangler resolves each pattern's zone from its hostname
  // with the same zone access `wrangler deploy --domain` already uses for the
  // app Worker, so a deployment names no zone of its own. The bundle contract
  // below ends in the `[alias]` table, so these top-level keys come first.
  const routes = controlPlaneRoutePatterns(input.publicOriginHost).map(quote).join(", ")
  return `name = ${quote(input.edgeWorkerName)}
main = ${quote(fromConfig(input.configDirectory, input.artifact.entrypointFromPackageRoot))}
# The control plane answers its paths on the app's own host through Worker
# routes, which "take precedence if configured on the same hostname" as the
# app Worker's custom domain (developers.cloudflare.com/workers/configuration/
# routing/routes/), so a request on them runs one Worker, not the app Worker
# and a service binding.
routes = [${routes}]
${HOSTED_WORKER_BUNDLE_CONTRACT}

${sharedWorkerConfig(input)}
[[services]]
binding = "CONTROL_PLANE_WRITER"
service = ${quote(input.workerName)}
${durableObjects(input.artifact).map((object) => `
[[durable_objects.bindings]]
name = ${quote(object.name)}
class_name = ${quote(object.className)}
script_name = ${quote(input.workerName)}
`).join("")}`
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

export const APP_WORKER = path.join(SERVER_ROOT, "scripts/deploy/app-worker.ts")

/**
 * The app Worker on the deployment's one public origin: the browser app's
 * assets, with the relay bound as a service behind `/relay`, so it is
 * published after the relay exists. It runs ahead of every asset: the relay's
 * paths, the hashed chunks whose fallback it refuses, and the shell whose
 * response names a signed-in boot's preloads. The control plane's paths never
 * reach it on a deployed origin: they are the control plane's own routes on
 * the same host (`renderWorkerWranglerConfig`). The assets serve a document
 * only at its own path (`html_handling = "none"`): the Worker fetches
 * `/login.html` by name for a signed-out visitor, and `/login` itself has no
 * file, so a signed-in browser there gets the single-page fallback, the shell,
 * as on every client route; `auto-trailing-slash` would have served the
 * signed-out document to anyone at `/login` and redirected `/index.html`.
 */
export function renderAppWranglerConfig(input: Readonly<{
  appWorkerName: string
  relayWorkerName: string
  browserDirectory: string
}>) {
  return `name = ${quote(input.appWorkerName)}
main = ${quote(APP_WORKER)}
compatibility_date = "2025-05-01"
workers_dev = false
preview_urls = false

[assets]
directory = ${quote(path.resolve(input.browserDirectory))}
binding = "ASSETS"
not_found_handling = "single-page-application"
html_handling = "none"
run_worker_first = true

[[services]]
binding = "RELAY"
service = ${quote(input.relayWorkerName)}
`
}
