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

function descriptor(serviceId: "documents"): FirstPartyServiceDescriptor {
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
  return { ...base, serviceId, bindingName: SERVICE_BINDINGS.documents }
}

describe("first-party service contract", () => {
  test("uses an immutable empty catalog as the canonical uninstalled state", () => {
    expect(EMPTY_SERVICE_CATALOG).toEqual([])
    expect(Object.isFrozen(EMPTY_SERVICE_CATALOG)).toBe(true)
  })

  test("accepts only the fixed service and its fixed binding", () => {
    expect(requireServiceDescriptor(descriptor("documents"))).toEqual(descriptor("documents"))
    expect(() => requireServiceDescriptor({ ...descriptor("documents"), serviceId: "plugin" })).toThrow(
      ServiceContractError,
    )
    expect(() => requireServiceDescriptor({ ...descriptor("documents"), bindingName: "ARBITRARY" })).toThrow(
      /fixed DOCUMENTS_SERVICE binding/,
    )
  })

  test("orders the data-only catalog and rejects duplicates", () => {
    expect(
      requireServiceCatalog([descriptor("documents")]).map((item) => item.serviceId),
    ).toEqual(["documents"])
    expect(() => requireServiceCatalog([descriptor("documents"), descriptor("documents")])).toThrow(/duplicate/)
  })

  test("projects an exact browser catalog without operator deployment metadata", () => {
    const projected = projectServiceCatalogForBrowser([{ ...descriptor("documents"), state: "enabled" }])
    expect(projected).toEqual([
      {
        serviceId: "documents",
        protocolVersion: SERVICE_PROTOCOL_VERSION,
        schemaVersion: 1,
        state: "enabled",
      },
    ])
    expect(() => requireBrowserServiceCatalog([descriptor("documents")])).toThrow(/operator-only fields/)
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
      serviceId: "documents",
      expectedRevision: 1,
      probe: { status: "ready", checkedAt: "2026-08-28T09:59:59Z", serviceBuildId: "build-a" },
    })
    expect(
      serializeServiceInstallationOperationIntent({
        action: "record_probe",
        identity,
        serviceId: "documents",
        expectedRevision: 1,
        probe: { status: "ready", checkedAt: "2026-08-28T09:59:59Z", serviceBuildId: "build-a" },
      }),
    ).toBe(first)
    expect(
      serializeServiceInstallationOperationIntent({
        action: "record_probe",
        identity,
        serviceId: "documents",
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
      serviceId: "documents",
      protocolVersion: SERVICE_PROTOCOL_VERSION,
      schemaVersion: 1,
      bindingName: SERVICE_BINDINGS.documents,
      entrypoint: "DocumentsServiceV1",
      bindingProvenance: "cloudflare-service:documents-prod",
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
    // A service's binding name is FIXED by the contract, not chosen by the
    // caller. Any other name — even a syntactically plausible one — must be
    // refused, or a lifecycle mutation could point a service at another
    // service's binding.
    expect(() =>
      requireServiceLifecycleMutationRequest({ ...request, bindingName: "OTHER_SERVICE" }),
    ).toThrow(/fixed service binding/)
    expect(() =>
      requireServiceLifecycleMutationRequest({ ...request, action: "enable", expectedRevision: 0 }),
    ).toThrow()
  })
})
