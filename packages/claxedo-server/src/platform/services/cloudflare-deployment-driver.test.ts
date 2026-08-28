import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test, vi } from "vitest"
import { Miniflare } from "miniflare"

import {
  SERVICE_BINDINGS,
  SERVICE_PROTOCOL_VERSION,
  serviceLifecycleStepIdentity,
  type FirstPartyServiceDescriptor,
} from "@claxedo/service-contract"

import { D1ServiceDeploymentStepStore } from "./adapters/d1-deployment-step-store"
import {
  CloudflareOptionalServiceDeploymentDriver,
  type CloudflareOptionalServiceRelease,
  type CloudflareOptionalServiceResources,
  type CloudflareOptionalServiceSafety,
} from "./cloudflare-deployment-driver"
import type { ServiceDeploymentStep, ServiceDeploymentStepIdentity } from "./lifecycle-coordinator"

const migrationPath = fileURLToPath(
  new URL("../../../migrations/control-plane/0009_optional_service_deployment.sql", import.meta.url),
)
const active: Miniflare[] = []
const databaseId = "11111111-1111-1111-1111-111111111111"

async function receipts() {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  const migration = (await readFile(migrationPath, "utf8")).replace(/^\s*--.*$/gm, "")
  for (const statement of migration
    .split(/;\s*\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)) {
    await database.prepare(statement).run()
  }
  return new D1ServiceDeploymentStepStore(database)
}

function descriptor(serviceId: "workgraph" | "documents"): FirstPartyServiceDescriptor {
  const common = {
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    schemaVersion: 1,
    state: "installed_disabled" as const,
    trust: {
      environmentId: "production",
      deploymentId: "deployment-1",
      bindingProvenance: `cloudflare-service:claxedo-${serviceId}-production`,
    },
  }
  return serviceId === "workgraph"
    ? { ...common, serviceId, bindingName: SERVICE_BINDINGS.workgraph, entrypoint: "WorkGraphServiceV1" }
    : { ...common, serviceId, bindingName: SERVICE_BINDINGS.documents, entrypoint: "DocumentsServiceV1" }
}

function step(serviceId: "workgraph" | "documents", value: ServiceDeploymentStep): ServiceDeploymentStepIdentity {
  const root = {
    environmentId: "production",
    deploymentId: "deployment-1",
    operationId: "install-1",
    occurredAt: "2026-08-28T00:00:00.000Z",
  }
  return {
    environmentId: root.environmentId,
    deploymentId: root.deploymentId,
    workflowOperationId: root.operationId,
    stepOperationId: serviceLifecycleStepIdentity(root, value).operationId,
    occurredAt: root.occurredAt,
    serviceId,
    serviceBuildId: `sha256:${"1".repeat(64)}`,
    bindingProvenance: `cloudflare-service:claxedo-${serviceId}-production`,
    step: value,
  }
}

afterEach(async () => Promise.all(active.splice(0).map((instance) => instance.dispose())))

describe.each(["workgraph", "documents"] as const)("%s Cloudflare production deployment driver", (serviceId) => {
  test("persists exact step receipts and drives the complete resource/binding safety lifecycle", async () => {
    const calls: string[] = []
    const bucketName = serviceId === "documents" ? "claxedo-documents-production" : undefined
    const resources: CloudflareOptionalServiceResources = {
      provision: vi.fn(async (input) => {
        calls.push(`provision:${input.serviceId}`)
        return { databaseId, ...(bucketName ? { bucketName } : {}) }
      }),
      inspect: vi.fn(async () => ({ databaseId, ...(bucketName ? { bucketName } : {}) })),
      retire: vi.fn(async (input) => {
        calls.push(`retire:${input.serviceId}:${input.retirementAuthorization}`)
      }),
    }
    const release: CloudflareOptionalServiceRelease = {
      applyMigrations: vi.fn(async (input) => {
        calls.push(`migrate:${input.serviceId}:${input.databaseId}`)
      }),
      deployDark: vi.fn(async (input) => {
        calls.push(`dark:${input.serviceId}:${input.databaseId}`)
      }),
      deployCoreBinding: vi.fn(async (input) => {
        calls.push(`binding:${input.serviceId}:${input.present}`)
      }),
      deleteServiceWorker: vi.fn(async (input) => {
        calls.push(`worker-delete:${input.serviceId}`)
      }),
    }
    const safety: CloudflareOptionalServiceSafety = {
      drainOperations: vi.fn(async (input) => {
        calls.push(`drain:${input.serviceId}`)
      }),
      revokeBridge: vi.fn(async (input) => {
        calls.push(`revoke:${input.serviceId}`)
      }),
    }
    const management = {
      probe: vi.fn(),
      applyLifecycle: vi.fn(async (request) => ({
        serviceId,
        action: request.action,
        operationId: request.identity.operationId,
        state: "installed_disabled" as const,
        revision: 1,
        serviceBuildId: request.serviceBuildId,
      })),
    }
    const driver = new CloudflareOptionalServiceDeploymentDriver({
      serviceId,
      workerName: `claxedo-${serviceId}-production`,
      databaseName: `claxedo-${serviceId}-production`,
      ...(bucketName ? { bucketName } : {}),
      retirementAuthorization: "archive:evidence-1",
      receipts: await receipts(),
      resources,
      release,
      safety,
      management,
    })

    for (const action of [
      "provision_resources",
      "apply_migrations",
      "deploy_dark",
      "add_core_binding",
      "drain_operations",
      "revoke_bridge",
      "remove_core_binding",
      "retire_resources",
    ] as const) {
      await driver.runStep(step(serviceId, action), descriptor(serviceId))
    }
    await driver.runStep(step(serviceId, "provision_resources"), descriptor(serviceId))

    expect(calls).toEqual([
      `provision:${serviceId}`,
      `migrate:${serviceId}:${databaseId}`,
      `dark:${serviceId}:${databaseId}`,
      `binding:${serviceId}:true`,
      `drain:${serviceId}`,
      `revoke:${serviceId}`,
      `binding:${serviceId}:false`,
      `worker-delete:${serviceId}`,
      `retire:${serviceId}:archive:evidence-1`,
    ])
    expect(resources.provision).toHaveBeenCalledTimes(1)
  })

  test("fails closed before destructive retirement without explicit archive/retirement evidence", async () => {
    const driver = new CloudflareOptionalServiceDeploymentDriver({
      serviceId,
      workerName: `claxedo-${serviceId}-production`,
      databaseName: `claxedo-${serviceId}-production`,
      ...(serviceId === "documents" ? { bucketName: "claxedo-documents-production" } : {}),
      receipts: await receipts(),
      resources: {
        provision: vi.fn(),
        inspect: vi.fn(async () => ({
          databaseId,
          ...(serviceId === "documents" ? { bucketName: "claxedo-documents-production" } : {}),
        })),
        retire: vi.fn(),
      },
      release: {
        applyMigrations: vi.fn(),
        deployDark: vi.fn(),
        deployCoreBinding: vi.fn(),
        deleteServiceWorker: vi.fn(),
      },
      safety: { drainOperations: vi.fn(), revokeBridge: vi.fn() },
      management: { probe: vi.fn(), applyLifecycle: vi.fn() },
    })
    await expect(driver.runStep(step(serviceId, "retire_resources"), descriptor(serviceId))).rejects.toThrow(
      /retirementAuthorization/,
    )
  })
})
