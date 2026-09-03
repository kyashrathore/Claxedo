import { describe, expect, test } from "vitest"

import { SERVICE_BINDINGS, SERVICE_PROTOCOL_VERSION } from "@claxedo/service-contract"

import { createDocumentsServiceManifest, renderDocumentsServiceWranglerConfig } from "./manifest"

const manifest = createDocumentsServiceManifest({
  environment: "staging",
  environmentId: "environment-staging",
  deploymentId: "deployment-staging",
  workerName: "claxedo-documents-staging",
  database: {
    name: "claxedo-documents-staging",
    id: "11111111-1111-1111-1111-111111111111",
  },
  bucket: { name: "claxedo-documents-staging" },
  serviceBuildId: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
})

describe("independent Documents service deployment manifest", () => {
  test("renders only Documents-owned D1 and R2 resources", () => {
    expect(manifest.descriptor).toEqual({
      serviceId: "documents",
      protocolVersion: SERVICE_PROTOCOL_VERSION,
      schemaVersion: 1,
      state: "installed_disabled",
      bindingName: SERVICE_BINDINGS.documents,
      entrypoint: "DocumentsServiceV1",
      trust: {
        environmentId: "environment-staging",
        deploymentId: "deployment-staging",
        bindingProvenance: "cloudflare-service:claxedo-documents-staging",
      },
    })
    expect(manifest.resources).toEqual({
      database: {
        binding: "DOCUMENTS_DB",
        name: "claxedo-documents-staging",
        id: "11111111-1111-1111-1111-111111111111",
        migrationsDirectory: "migrations",
      },
      bucket: {
        binding: "DOCUMENTS_BUCKET",
        name: "claxedo-documents-staging",
      },
    })

    const config = renderDocumentsServiceWranglerConfig(manifest)
    expect(config).toContain('main = "src/worker.cf.ts"')
    expect(config).toContain(
      'binding = "DOCUMENTS_DB"\ndatabase_name = "claxedo-documents-staging"\ndatabase_id = "11111111-1111-1111-1111-111111111111"\nmigrations_dir = "migrations"',
    )
    expect(config).toContain('binding = "DOCUMENTS_BUCKET"\nbucket_name = "claxedo-documents-staging"')
    expect(config).toContain('CLAXEDO_DOCUMENTS_INITIAL_STATE = "installed_disabled"')
    expect(config).toContain("workers_dev = false")
    expect(config).toContain("preview_urls = false")

    for (const forbidden of [
      "AUTH_DB",
      "CONTROL_PLANE_DB",
      'binding = "CLAXEDO_DOCUMENTS"',
      'binding = "DOCUMENTS_SERVICE"',
      "POLAR",
      "GOOGLE_CLIENT",
      "GITHUB_CLIENT",
      "BETTER_AUTH",
      "USER_CREDENTIAL",
      "RELAY",
      "SANDBOX",
      "[[services]]",
      "[[durable_objects",
      "[[queues",
      "[triggers]",
      "crons",
    ]) {
      expect(config).not.toContain(forbidden)
    }
  })
})
