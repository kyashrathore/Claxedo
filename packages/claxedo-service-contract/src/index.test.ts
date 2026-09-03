import { describe, expect, test } from "bun:test"

import {
  EMPTY_SERVICE_CATALOG,
  SERVICE_BINDINGS,
  SERVICE_PROTOCOL_VERSION,
  ServiceContractError,
  projectServiceCatalogForBrowser,
  requireBrowserServiceCatalog,
  requireServiceCatalog,
  requireServiceDescriptor,
  requireServiceLifecycleMutationRequest,
  serializeServiceLifecycleMutationRequest,
  serializeServiceInstallationOperationIntent,
  serviceLifecycleStepIdentity,
  type FirstPartyServiceDescriptor,
} from "./index"

function descriptor(serviceId: "workgraph" | "documents"): FirstPartyServiceDescriptor {
  const base = {
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    schemaVersion: 1,
    state: "installed_disabled" as const,
    entrypoint: `${serviceId}-v1`,
    trust: {
      environmentId: "production",
      deploymentId: "deployment-1",
      bindingProvenance: `cloudflare-service:${serviceId}`,
    },
  }
  return serviceId === "workgraph"
    ? { ...base, serviceId, bindingName: SERVICE_BINDINGS.workgraph }
    : { ...base, serviceId, bindingName: SERVICE_BINDINGS.documents }
}

describe("first-party service contract", () => {
  test("uses an immutable empty catalog as the canonical uninstalled state", () => {
    expect(EMPTY_SERVICE_CATALOG).toEqual([])
    expect(Object.isFrozen(EMPTY_SERVICE_CATALOG)).toBe(true)
  })

  test("accepts only the two fixed services and their fixed bindings", () => {
    expect(requireServiceDescriptor(descriptor("workgraph"))).toEqual(descriptor("workgraph"))
    expect(requireServiceDescriptor(descriptor("documents"))).toEqual(descriptor("documents"))
    expect(() => requireServiceDescriptor({ ...descriptor("workgraph"), serviceId: "plugin" })).toThrow(
      ServiceContractError,
    )
    expect(() => requireServiceDescriptor({ ...descriptor("workgraph"), bindingName: "ARBITRARY" })).toThrow(
      /fixed WORKGRAPH_SERVICE binding/,
    )
  })

  test("orders the data-only catalog and rejects duplicates", () => {
    expect(
      requireServiceCatalog([descriptor("workgraph"), descriptor("documents")]).map((item) => item.serviceId),
    ).toEqual(["documents", "workgraph"])
    expect(() => requireServiceCatalog([descriptor("workgraph"), descriptor("workgraph")])).toThrow(/duplicate/)
  })

  test("projects an exact browser catalog without operator deployment metadata", () => {
    const projected = projectServiceCatalogForBrowser([{ ...descriptor("workgraph"), state: "enabled" }])
    expect(projected).toEqual([
      {
        serviceId: "workgraph",
        protocolVersion: SERVICE_PROTOCOL_VERSION,
        schemaVersion: 1,
        state: "enabled",
      },
    ])
    expect(() => requireBrowserServiceCatalog([descriptor("workgraph")])).toThrow(/operator-only fields/)
  })

  test("binds a workflow operation id to one exact normalized intent", () => {
    const identity = {
      environmentId: "production",
      deploymentId: "deployment-1",
      operationId: "operation-1",
      occurredAt: "2026-08-28T10:00:00Z",
    }
    const first = serializeServiceInstallationOperationIntent({
      action: "record_probe",
      identity,
      serviceId: "workgraph",
      expectedRevision: 1,
      probe: { status: "ready", checkedAt: "2026-08-28T09:59:59Z", serviceBuildId: "build-a" },
    })
    expect(
      serializeServiceInstallationOperationIntent({
        action: "record_probe",
        identity,
        serviceId: "workgraph",
        expectedRevision: 1,
        probe: { status: "ready", checkedAt: "2026-08-28T09:59:59Z", serviceBuildId: "build-a" },
      }),
    ).toBe(first)
    expect(
      serializeServiceInstallationOperationIntent({
        action: "record_probe",
        identity,
        serviceId: "workgraph",
        expectedRevision: 1,
        probe: { status: "ready", checkedAt: "2026-08-28T09:59:59Z", serviceBuildId: "build-b" },
      }),
    ).not.toBe(first)
  })

  test("binds service-local mutations to exact deployment and artifact provenance", () => {
    const identity = {
      environmentId: "production",
      deploymentId: "deployment-1",
      operationId: "install-1",
      occurredAt: "2026-08-28T10:00:00Z",
    }
    const request = {
      action: "initialize_disabled",
      identity: serviceLifecycleStepIdentity(identity, "initialize"),
      serviceId: "workgraph",
      protocolVersion: SERVICE_PROTOCOL_VERSION,
      schemaVersion: 1,
      bindingName: SERVICE_BINDINGS.workgraph,
      entrypoint: "WorkGraphServiceV1",
      bindingProvenance: "cloudflare-service:workgraph-prod",
      serviceBuildId: "sha256:build-a",
      expectedRevision: 0,
    } as const
    expect(requireServiceLifecycleMutationRequest(request)).toEqual(request)
    expect(serializeServiceLifecycleMutationRequest(request)).toBe(
      serializeServiceLifecycleMutationRequest({ ...request }),
    )
    expect(serviceLifecycleStepIdentity({ ...identity, operationId: "a:b" }, "c").operationId).not.toBe(
      serviceLifecycleStepIdentity({ ...identity, operationId: "a" }, "b:c").operationId,
    )
    expect(() =>
      requireServiceLifecycleMutationRequest({ ...request, bindingName: SERVICE_BINDINGS.documents }),
    ).toThrow(/fixed service binding/)
    expect(() =>
      requireServiceLifecycleMutationRequest({ ...request, action: "enable", expectedRevision: 0 }),
    ).toThrow()
  })
})
