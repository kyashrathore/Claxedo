import { describe, expect, test, vi } from "vitest"

import { SERVICE_PROTOCOL_VERSION } from "@claxedo/service-contract"
import type { DocumentsJobRequest } from "@claxedo/service-contract/documents"

import { DocumentsServiceLifecycleError, createDocumentsServiceRpc } from "./service"

const deployment = {
  environmentId: "environment-staging",
  deploymentId: "deployment-staging",
  serviceBuildId: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  bindingName: "DOCUMENTS_SERVICE" as const,
  entrypoint: "DocumentsServiceV1" as const,
  bindingProvenance: "cloudflare-service:documents-staging",
}

describe("Documents private service entrypoint", () => {
  test("probes as installed-disabled and refuses enqueue before reading the operation", async () => {
    const service = createDocumentsServiceRpc({
      ...deployment,
      lifecycle: {
        read: async () => ({ ...deployment, state: "installed_disabled", revision: 1 }),
      },
    })

    await expect(
      service.probe({
        environmentId: deployment.environmentId,
        deploymentId: deployment.deploymentId,
        installationRevision: 1,
        protocolVersion: SERVICE_PROTOCOL_VERSION,
      }),
    ).resolves.toEqual({
      serviceId: "documents",
      protocolVersion: SERVICE_PROTOCOL_VERSION,
      schemaVersion: 1,
      state: "installed_disabled",
      serviceBuildId: deployment.serviceBuildId,
    })

    const unreadableRequest: DocumentsJobRequest = {
      get operationId(): string {
        throw new Error("operation was read")
      },
      get operationGrant(): string {
        throw new Error("operation was read")
      },
      get organizationId(): string {
        throw new Error("operation was read")
      },
      get actorId(): string {
        throw new Error("operation was read")
      },
      get job(): "persist_document_revision" {
        throw new Error("operation was read")
      },
      get payload(): Readonly<Record<string, unknown>> {
        throw new Error("operation was read")
      },
    }
    await expect(service.enqueue(unreadableRequest)).rejects.toMatchObject({
      code: "service_disabled",
    })
  })

  test("fails enabled work explicitly until the isolated grant, job, and R2 adapters exist", async () => {
    const service = createDocumentsServiceRpc({
      ...deployment,
      lifecycle: {
        read: async () => ({ ...deployment, state: "enabled", revision: 2 }),
      },
    })

    await expect(
      service.enqueue({
        operationId: "operation-1",
        operationGrant: "opaque-core-grant",
        organizationId: "organization-1",
        actorId: "actor-1",
        job: "persist_document_revision",
        payload: {},
      }),
    ).rejects.toMatchObject({
      code: "runtime_unavailable",
      message: expect.stringMatching(/grant verifier.*D1 job.*R2 revision/i),
    })
  })

  test("rejects a probe for another installation before exposing lifecycle state", async () => {
    const service = createDocumentsServiceRpc({
      ...deployment,
      lifecycle: {
        read: async () => ({ ...deployment, state: "installed_disabled", revision: 1 }),
      },
    })

    await expect(
      service.probe({
        environmentId: deployment.environmentId,
        deploymentId: "another-deployment",
        installationRevision: 1,
        protocolVersion: SERVICE_PROTOCOL_VERSION,
      }),
    ).rejects.toBeInstanceOf(DocumentsServiceLifecycleError)
  })

  test("rejects a stale installation revision instead of probing another lifecycle generation", async () => {
    const service = createDocumentsServiceRpc({
      ...deployment,
      lifecycle: {
        read: async () => ({ ...deployment, state: "installed_disabled", revision: 2 }),
      },
    })

    await expect(
      service.probe({
        environmentId: deployment.environmentId,
        deploymentId: deployment.deploymentId,
        installationRevision: 1,
        protocolVersion: SERVICE_PROTOCOL_VERSION,
      }),
    ).rejects.toMatchObject({ code: "lifecycle_mismatch" })
  })

  test("reports enabled as unhealthy until a real D1/R2 runtime passes its health probe", async () => {
    const request = {
      environmentId: deployment.environmentId,
      deploymentId: deployment.deploymentId,
      installationRevision: 2,
      protocolVersion: SERVICE_PROTOCOL_VERSION,
    }
    const lifecycle = {
      read: async () => ({ ...deployment, state: "enabled" as const, revision: 2 }),
    }

    await expect(createDocumentsServiceRpc({ ...deployment, lifecycle }).probe(request)).rejects.toMatchObject({
      code: "runtime_unavailable",
    })

    const runtime = {
      probe: vi.fn(async () => undefined),
      enqueue: vi.fn(async (operation: { operationId: string }) => ({
        operationId: operation.operationId,
        accepted: true,
        jobId: "job-1",
      })),
    }
    const healthy = createDocumentsServiceRpc({ ...deployment, lifecycle, runtime })
    await expect(healthy.probe(request)).resolves.toMatchObject({ state: "enabled" })
    expect(runtime.probe).toHaveBeenCalledTimes(1)
    await expect(
      healthy.enqueue({
        operationId: "operation-1",
        operationGrant: "opaque-core-grant",
        organizationId: "organization-1",
        actorId: "actor-1",
        job: "persist_document_revision",
        payload: {},
      }),
    ).resolves.toEqual({ operationId: "operation-1", accepted: true, jobId: "job-1" })
  })
})
