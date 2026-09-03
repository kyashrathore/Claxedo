import { describe, expect, test } from "vitest"
import { SERVICE_BINDINGS, SERVICE_PROTOCOL_VERSION, type FirstPartyServiceDescriptor } from "@claxedo/service-contract"

import { createDocumentsServiceGateway } from "./documents"
import { ServiceGatewayUnavailableError } from "./service-gateway"

function descriptor(serviceId: "documents", state: "installed_disabled" | "enabled") {
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

describe("optional service gateways", () => {
  test("uses one non-enumerating failure for uninstalled, disabled, and missing-binding states", async () => {
    for (const gateway of [
      createDocumentsServiceGateway({ descriptor: null }),
      createDocumentsServiceGateway({ descriptor: descriptor("documents", "installed_disabled") }),
      createDocumentsServiceGateway({ descriptor: descriptor("documents", "enabled") }),
    ]) {
      await expect(gateway.enqueue(request)).rejects.toMatchObject({
        name: "ServiceGatewayUnavailableError",
        message: "Service unavailable",
        status: 404,
      })
    }
  })

  test("forwards a delayed Documents job only through its enabled binding and checks operation identity", async () => {
    await expect(
      createDocumentsServiceGateway({ descriptor: descriptor("documents", "enabled"), binding }).enqueue(request),
    ).resolves.toEqual({ operationId: "op-2", accepted: true, jobId: "job-1" })
    await expect(
      createDocumentsServiceGateway({
        descriptor: descriptor("documents", "enabled"),
        binding: { ...binding, enqueue: async () => ({ operationId: "wrong", accepted: true, jobId: "job-1" }) },
      }).enqueue(request),
    ).rejects.toBeInstanceOf(ServiceGatewayUnavailableError)
  })
})
