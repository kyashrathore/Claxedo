import {
  SERVICE_BINDINGS,
  SERVICE_PROTOCOL_VERSION,
  requireServiceDescriptor,
  type DocumentsServiceDescriptor,
} from "@claxedo/service-contract"

import { DOCUMENTS_SERVICE_ENTRYPOINT, DOCUMENTS_SERVICE_SCHEMA_VERSION } from "../constants"

export { DOCUMENTS_SERVICE_ENTRYPOINT, DOCUMENTS_SERVICE_SCHEMA_VERSION }

export type DocumentsServiceDeploymentManifest = Readonly<{
  environment: "production" | "staging"
  workerName: string
  serviceBuildId: string
  descriptor: DocumentsServiceDescriptor
  resources: Readonly<{
    database: Readonly<{
      binding: "DOCUMENTS_DB"
      name: string
      id: string
      migrationsDirectory: "migrations"
    }>
    bucket: Readonly<{
      binding: "DOCUMENTS_BUCKET"
      name: string
    }>
  }>
}>

type DocumentsServiceManifestInput = Readonly<{
  environment: "production" | "staging"
  environmentId: string
  deploymentId: string
  workerName: string
  database: Readonly<{ name: string; id: string }>
  bucket: Readonly<{ name: string }>
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

export function createDocumentsServiceManifest(
  input: DocumentsServiceManifestInput,
): DocumentsServiceDeploymentManifest {
  const name = workerName(input.workerName)
  const descriptor = requireServiceDescriptor({
    serviceId: "documents",
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    schemaVersion: DOCUMENTS_SERVICE_SCHEMA_VERSION,
    state: "installed_disabled",
    bindingName: SERVICE_BINDINGS.documents,
    entrypoint: DOCUMENTS_SERVICE_ENTRYPOINT,
    trust: {
      environmentId: requiredText(input.environmentId, "environmentId"),
      deploymentId: requiredText(input.deploymentId, "deploymentId"),
      bindingProvenance: `cloudflare-service:${name}`,
    },
  })
  if (descriptor.serviceId !== "documents") throw new Error("Documents manifest resolved another service")
  return Object.freeze({
    environment: input.environment,
    workerName: name,
    resources: Object.freeze({
      database: Object.freeze({
        binding: "DOCUMENTS_DB" as const,
        name: requiredText(input.database.name, "database.name"),
        id: databaseId(input.database.id),
        migrationsDirectory: "migrations" as const,
      }),
      bucket: Object.freeze({
        binding: "DOCUMENTS_BUCKET" as const,
        name: requiredText(input.bucket.name, "bucket.name"),
      }),
    }),
    serviceBuildId: buildId(input.serviceBuildId),
    descriptor,
  })
}

export function renderDocumentsServiceWranglerConfig(manifest: DocumentsServiceDeploymentManifest) {
  const input = createDocumentsServiceManifest({
    environment: manifest.environment,
    environmentId: manifest.descriptor.trust.environmentId,
    deploymentId: manifest.descriptor.trust.deploymentId,
    workerName: manifest.workerName,
    database: manifest.resources.database,
    bucket: manifest.resources.bucket,
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
CLAXEDO_DOCUMENTS_ENVIRONMENT_ID = ${quote(input.descriptor.trust.environmentId)}
CLAXEDO_DOCUMENTS_DEPLOYMENT_ID = ${quote(input.descriptor.trust.deploymentId)}
CLAXEDO_DOCUMENTS_SERVICE_BUILD_ID = ${quote(input.serviceBuildId)}
CLAXEDO_DOCUMENTS_BINDING_PROVENANCE = ${quote(input.descriptor.trust.bindingProvenance)}
CLAXEDO_DOCUMENTS_INITIAL_STATE = "installed_disabled"

[[d1_databases]]
binding = "DOCUMENTS_DB"
database_name = ${quote(input.resources.database.name)}
database_id = ${quote(input.resources.database.id)}
migrations_dir = "migrations"

[[r2_buckets]]
binding = "DOCUMENTS_BUCKET"
bucket_name = ${quote(input.resources.bucket.name)}
`
}
