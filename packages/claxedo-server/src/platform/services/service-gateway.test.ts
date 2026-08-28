import { describe, expect, test } from "vitest"
import { SERVICE_BINDINGS, SERVICE_PROTOCOL_VERSION, type FirstPartyServiceDescriptor } from "@claxedo/service-contract"

import { createDocumentsServiceGateway } from "./documents"
import { ServiceGatewayUnavailableError } from "./service-gateway"
import { createWorkGraphServiceGateway } from "./workgraph"

function descriptor(serviceId: "workgraph" | "documents", state: "installed_disabled" | "enabled") {
  return {
    serviceId,
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    schemaVersion: 1,
    state,
    bindingName: SERVICE_BINDINGS[serviceId],
    entrypoint: `${serviceId}-v1`,
    trust: { environmentId: "production", deploymentId: "deployment-1", bindingProvenance: "test" },
  } as FirstPartyServiceDescriptor
}

describe("optional service gateways", () => {
  test("uses one non-enumerating failure for uninstalled, disabled, and missing-binding states", async () => {
    const request = {
      operationId: "op-1",
      operationGrant: "grant",
      organizationId: "org-1",
      actorId: "actor-1",
      mutation: "record_work_item_transition" as const,
      payload: {},
    }
    for (const gateway of [
      createWorkGraphServiceGateway({ descriptor: null }),
      createWorkGraphServiceGateway({ descriptor: descriptor("workgraph", "installed_disabled") }),
      createWorkGraphServiceGateway({ descriptor: descriptor("workgraph", "enabled") }),
    ]) {
      await expect(gateway.mutate(request)).rejects.toMatchObject({
        name: "ServiceGatewayUnavailableError",
        message: "Service unavailable",
        status: 404,
      })
    }
  })

  test("forwards only through an enabled WorkGraph binding and checks operation identity", async () => {
    const request = {
      operationId: "op-1",
      operationGrant: "grant",
      organizationId: "org-1",
      actorId: "actor-1",
      mutation: "record_work_item_transition" as const,
      payload: {},
    }
    const binding = {
      probe: async () => ({
        serviceId: "workgraph" as const,
        protocolVersion: SERVICE_PROTOCOL_VERSION,
        schemaVersion: 1,
        state: "enabled" as const,
        serviceBuildId: "build-1",
      }),
      mutate: async () => ({ operationId: "op-1", committed: true, revision: "1" }),
    }
    await expect(
      createWorkGraphServiceGateway({ descriptor: descriptor("workgraph", "enabled"), binding }).mutate(request),
    ).resolves.toEqual({ operationId: "op-1", committed: true, revision: "1" })
    await expect(
      createWorkGraphServiceGateway({
        descriptor: descriptor("workgraph", "enabled"),
        binding: { ...binding, mutate: async () => ({ operationId: "wrong", committed: true, revision: "1" }) },
      }).mutate(request),
    ).rejects.toBeInstanceOf(ServiceGatewayUnavailableError)
  })

  test("forwards a delayed Documents job only through its enabled binding", async () => {
    const request = {
      operationId: "op-2",
      operationGrant: "grant",
      organizationId: "org-1",
      actorId: "actor-1",
      job: "persist_document_revision" as const,
      payload: {},
    }
    const binding = {
      probe: async () => ({
        serviceId: "documents" as const,
        protocolVersion: SERVICE_PROTOCOL_VERSION,
        schemaVersion: 1,
        state: "enabled" as const,
        serviceBuildId: "build-1",
      }),
      enqueue: async () => ({ operationId: "op-2", accepted: true, jobId: "job-1" }),
    }
    await expect(
      createDocumentsServiceGateway({ descriptor: descriptor("documents", "enabled"), binding }).enqueue(request),
    ).resolves.toEqual({ operationId: "op-2", accepted: true, jobId: "job-1" })
  })
})
