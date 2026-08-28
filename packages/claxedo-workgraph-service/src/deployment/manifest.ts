import {
  SERVICE_BINDINGS,
  SERVICE_PROTOCOL_VERSION,
  requireServiceDescriptor,
  type WorkGraphServiceDescriptor,
} from "@claxedo/service-contract"

import { WORKGRAPH_SERVICE_CRONS, WORKGRAPH_SERVICE_ENTRYPOINT, WORKGRAPH_SERVICE_SCHEMA_VERSION } from "../constants"

export { WORKGRAPH_SERVICE_CRONS, WORKGRAPH_SERVICE_ENTRYPOINT, WORKGRAPH_SERVICE_SCHEMA_VERSION }

export type WorkGraphServiceDeploymentManifest = Readonly<{
  environment: "production" | "staging"
  workerName: string
  serviceBuildId: string
  descriptor: WorkGraphServiceDescriptor
  resources: Readonly<{
    database: Readonly<{
      binding: "WORKGRAPH_DB"
      name: string
      id: string
      migrationsDirectory: "migrations"
    }>
    durableObjects: readonly Readonly<{
      binding: "WORKGRAPH_SETTLER" | "WORKGRAPH_WAKE_LANE"
      className: "WorkGraphSettler" | "WorkGraphWakeLane"
      migrationTag: "v1" | "v2"
    }>[]
    crons: typeof WORKGRAPH_SERVICE_CRONS
  }>
}>

type WorkGraphServiceManifestInput = Readonly<{
  environment: "production" | "staging"
  environmentId: string
  deploymentId: string
  workerName: string
  database: Readonly<{ name: string; id: string }>
  serviceBuildId: string
}>

function requiredText(value: string, name: string) {
  if (!value || value.trim() !== value) throw new Error(`${name} must be a non-empty trimmed string`)
  return value
}

function workerName(value: string) {
  const name = requiredText(value, "workerName")
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(name)) throw new Error("workerName must be a valid Cloudflare Worker name")
  return name
}

function databaseId(value: string) {
  const id = requiredText(value, "database.id")
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("database.id must be a real D1 UUID")
  }
  return id
}

function buildId(value: string) {
  const id = requiredText(value, "serviceBuildId")
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error("serviceBuildId must be a SHA-256 artifact identity")
  return id
}

export function createWorkGraphServiceManifest(
  input: WorkGraphServiceManifestInput,
): WorkGraphServiceDeploymentManifest {
  const name = workerName(input.workerName)
  const descriptor = requireServiceDescriptor({
    serviceId: "workgraph",
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    schemaVersion: WORKGRAPH_SERVICE_SCHEMA_VERSION,
    state: "installed_disabled",
    bindingName: SERVICE_BINDINGS.workgraph,
    entrypoint: WORKGRAPH_SERVICE_ENTRYPOINT,
    trust: {
      environmentId: requiredText(input.environmentId, "environmentId"),
      deploymentId: requiredText(input.deploymentId, "deploymentId"),
      bindingProvenance: `cloudflare-service:${name}`,
    },
  })
  if (descriptor.serviceId !== "workgraph") throw new Error("WorkGraph manifest resolved another service")
  return Object.freeze({
    environment: input.environment,
    workerName: name,
    resources: Object.freeze({
      database: Object.freeze({
        binding: "WORKGRAPH_DB" as const,
        name: requiredText(input.database.name, "database.name"),
        id: databaseId(input.database.id),
        migrationsDirectory: "migrations" as const,
      }),
      durableObjects: Object.freeze([
        Object.freeze({
          binding: "WORKGRAPH_SETTLER" as const,
          className: "WorkGraphSettler" as const,
          migrationTag: "v1" as const,
        }),
        Object.freeze({
          binding: "WORKGRAPH_WAKE_LANE" as const,
          className: "WorkGraphWakeLane" as const,
          migrationTag: "v2" as const,
        }),
      ]),
      crons: WORKGRAPH_SERVICE_CRONS,
    }),
    serviceBuildId: buildId(input.serviceBuildId),
    descriptor,
  })
}

export function renderWorkGraphServiceWranglerConfig(manifest: WorkGraphServiceDeploymentManifest) {
  const input = createWorkGraphServiceManifest({
    environment: manifest.environment,
    environmentId: manifest.descriptor.trust.environmentId,
    deploymentId: manifest.descriptor.trust.deploymentId,
    workerName: manifest.workerName,
    database: manifest.resources.database,
    serviceBuildId: manifest.serviceBuildId,
  })
  const quote = (value: string) => JSON.stringify(value)
  return `name = ${quote(input.workerName)}
main = "src/worker.cf.ts"
compatibility_date = "2025-05-01"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
workers_dev = false
preview_urls = false

[observability]
enabled = true

[vars]
CLAXEDO_WORKGRAPH_ENVIRONMENT_ID = ${quote(input.descriptor.trust.environmentId)}
CLAXEDO_WORKGRAPH_DEPLOYMENT_ID = ${quote(input.descriptor.trust.deploymentId)}
CLAXEDO_WORKGRAPH_SERVICE_BUILD_ID = ${quote(input.serviceBuildId)}
CLAXEDO_WORKGRAPH_BINDING_PROVENANCE = ${quote(input.descriptor.trust.bindingProvenance)}
CLAXEDO_WORKGRAPH_INITIAL_STATE = "installed_disabled"

[[d1_databases]]
binding = "WORKGRAPH_DB"
database_name = ${quote(input.resources.database.name)}
database_id = ${quote(input.resources.database.id)}
migrations_dir = "migrations"

[[durable_objects.bindings]]
name = "WORKGRAPH_SETTLER"
class_name = "WorkGraphSettler"

[[durable_objects.bindings]]
name = "WORKGRAPH_WAKE_LANE"
class_name = "WorkGraphWakeLane"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["WorkGraphSettler"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["WorkGraphWakeLane"]

[triggers]
crons = [${WORKGRAPH_SERVICE_CRONS.map(quote).join(", ")}]
`
}

/**
 * Explicit uninstall-only artifact. Deploying the v3 deleted_classes migration
 * retires both service-owned Durable Object namespaces before the Worker and
 * its D1 database are deleted. It has no bindings or cron that can start work.
 */
export function renderWorkGraphServiceRetirementWranglerConfig(manifest: WorkGraphServiceDeploymentManifest) {
  const input = createWorkGraphServiceManifest({
    environment: manifest.environment,
    environmentId: manifest.descriptor.trust.environmentId,
    deploymentId: manifest.descriptor.trust.deploymentId,
    workerName: manifest.workerName,
    database: manifest.resources.database,
    serviceBuildId: manifest.serviceBuildId,
  })
  const quote = (value: string) => JSON.stringify(value)
  return `name = ${quote(input.workerName)}
main = "src/worker.cf.ts"
compatibility_date = "2025-05-01"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
workers_dev = false
preview_urls = false

[vars]
CLAXEDO_WORKGRAPH_ENVIRONMENT_ID = ${quote(input.descriptor.trust.environmentId)}
CLAXEDO_WORKGRAPH_DEPLOYMENT_ID = ${quote(input.descriptor.trust.deploymentId)}
CLAXEDO_WORKGRAPH_SERVICE_BUILD_ID = ${quote(input.serviceBuildId)}
CLAXEDO_WORKGRAPH_BINDING_PROVENANCE = ${quote(input.descriptor.trust.bindingProvenance)}
CLAXEDO_WORKGRAPH_INITIAL_STATE = "installed_disabled"

[[d1_databases]]
binding = "WORKGRAPH_DB"
database_name = ${quote(input.resources.database.name)}
database_id = ${quote(input.resources.database.id)}
migrations_dir = "migrations"

[[migrations]]
tag = "v3-retire"
deleted_classes = ["WorkGraphSettler", "WorkGraphWakeLane"]
`
}
