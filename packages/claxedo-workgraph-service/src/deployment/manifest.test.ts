import { describe, expect, test } from "vitest"

import { SERVICE_BINDINGS, SERVICE_PROTOCOL_VERSION } from "@claxedo/service-contract"

import {
  createWorkGraphServiceManifest,
  renderWorkGraphServiceRetirementWranglerConfig,
  renderWorkGraphServiceWranglerConfig,
} from "./manifest"

const manifest = createWorkGraphServiceManifest({
  environment: "staging",
  environmentId: "environment-staging",
  deploymentId: "deployment-staging",
  workerName: "claxedo-workgraph-staging",
  database: {
    name: "claxedo-workgraph-staging",
    id: "11111111-1111-1111-1111-111111111111",
  },
  serviceBuildId: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
})

describe("independent WorkGraph service deployment manifest", () => {
  test("renders only WorkGraph-owned D1, Durable Object, and cron resources", () => {
    expect(manifest.descriptor).toEqual({
      serviceId: "workgraph",
      protocolVersion: SERVICE_PROTOCOL_VERSION,
      schemaVersion: 1,
      state: "installed_disabled",
      bindingName: SERVICE_BINDINGS.workgraph,
      entrypoint: "WorkGraphServiceV1",
      trust: {
        environmentId: "environment-staging",
        deploymentId: "deployment-staging",
        bindingProvenance: "cloudflare-service:claxedo-workgraph-staging",
      },
    })
    expect(manifest.resources).toEqual({
      database: {
        binding: "WORKGRAPH_DB",
        name: "claxedo-workgraph-staging",
        id: "11111111-1111-1111-1111-111111111111",
        migrationsDirectory: "migrations",
      },
      durableObjects: [
        { binding: "WORKGRAPH_SETTLER", className: "WorkGraphSettler", migrationTag: "v1" },
        { binding: "WORKGRAPH_WAKE_LANE", className: "WorkGraphWakeLane", migrationTag: "v2" },
      ],
      crons: ["* * * * *", "*/15 * * * *"],
    })

    const config = renderWorkGraphServiceWranglerConfig(manifest)
    expect(config).toContain('main = "src/worker.cf.ts"')
    expect(config).toContain(
      'binding = "WORKGRAPH_DB"\ndatabase_name = "claxedo-workgraph-staging"\ndatabase_id = "11111111-1111-1111-1111-111111111111"\nmigrations_dir = "migrations"',
    )
    expect(config).toContain('name = "WORKGRAPH_SETTLER"\nclass_name = "WorkGraphSettler"')
    expect(config).toContain('name = "WORKGRAPH_WAKE_LANE"\nclass_name = "WorkGraphWakeLane"')
    expect(config).toContain('crons = ["* * * * *", "*/15 * * * *"]')
    expect(config).toContain('CLAXEDO_WORKGRAPH_INITIAL_STATE = "installed_disabled"')
    expect(config).toContain("workers_dev = false")
    expect(config).toContain("preview_urls = false")

    for (const forbidden of [
      "AUTH_DB",
      "CONTROL_PLANE_DB",
      "CLAXEDO_DOCUMENTS",
      "DOCUMENTS_SERVICE",
      'binding = "WORKGRAPH_SERVICE"',
      "CLERK",
      "CONVEX",
      "GOOGLE_CLIENT",
      "GITHUB_CLIENT",
      "BETTER_AUTH",
      "[[services]]",
      "[[r2_buckets]]",
      "[[kv_namespaces]]",
      "[[queues",
    ]) {
      expect(config).not.toContain(forbidden)
    }
  })

  test("renders an explicit retirement artifact that removes both DO classes and all work triggers", () => {
    const config = renderWorkGraphServiceRetirementWranglerConfig(manifest)
    expect(config).toContain('tag = "v3-retire"')
    expect(config).toContain('deleted_classes = ["WorkGraphSettler", "WorkGraphWakeLane"]')
    expect(config).not.toMatch(/\[\[durable_objects\.bindings\]\]|\[triggers\]|crons =/)
    expect(config).toContain('binding = "WORKGRAPH_DB"')
  })
})
