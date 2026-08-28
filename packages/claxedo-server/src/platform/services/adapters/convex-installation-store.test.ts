import { describe, expect, test } from "vitest"
import { SERVICE_BINDINGS, SERVICE_PROTOCOL_VERSION } from "@claxedo/service-contract"

import { ConvexServiceInstallationStore, type ConvexInstallationExecutor } from "./convex-installation-store"

const descriptor = {
  serviceId: "documents" as const,
  protocolVersion: SERVICE_PROTOCOL_VERSION,
  schemaVersion: 1,
  state: "installed_disabled" as const,
  bindingName: SERVICE_BINDINGS.documents,
  entrypoint: "DocumentsServiceV1",
  trust: {
    environmentId: "staging",
    deploymentId: "deployment-1",
    bindingProvenance: "cloudflare-service:documents-staging",
  },
}

describe("Convex service installation adapter", () => {
  test("uses the fixed generated-operation vocabulary and validates returned descriptors", async () => {
    const calls: Array<{ kind: string; operation: string; input: Readonly<Record<string, unknown>> }> = []
    const executor: ConvexInstallationExecutor = {
      async query(operation, input) {
        calls.push({ kind: "query", operation, input })
        if (operation === "serviceInstallations:list") return [{ descriptor, revision: 1 }]
        if (operation === "serviceInstallations:get") return { descriptor, revision: 1 }
        if (operation === "serviceInstallations:audit") {
          return [{
            environmentId: "staging",
            deploymentId: "deployment-1",
            operationId: "op-1",
            serviceId: "documents",
            action: "register_disabled",
            toRevision: 1,
            occurredAt: "2026-08-28T00:00:00Z",
          }]
        }
        return []
      },
      async mutation(operation, input) {
        calls.push({ kind: "mutation", operation, input })
        return { descriptor, revision: 1 }
      },
    }
    const store = new ConvexServiceInstallationStore(executor)
    const scope = { environmentId: "staging", deploymentId: "deployment-1" }
    expect(await store.list(scope)).toEqual([{ descriptor, revision: 1 }])
    expect(await store.get(scope, "documents")).toEqual({ descriptor, revision: 1 })
    expect(await store.audit(scope)).toEqual([{
      environmentId: "staging",
      deploymentId: "deployment-1",
      operationId: "op-1",
      serviceId: "documents",
      action: "register_disabled",
      fromRevision: null,
      toRevision: 1,
      occurredAt: "2026-08-28T00:00:00Z",
    }])
    await store.registerDisabled({ ...scope, operationId: "op-1", occurredAt: "2026-08-28T00:00:00Z" }, descriptor)
    expect(calls.map((call) => call.operation)).toEqual([
      "serviceInstallations:list",
      "serviceInstallations:get",
      "serviceInstallations:audit",
      "serviceInstallations:registerDisabled",
    ])
  })

  test("rejects provider rows that escape the requested deployment scope", async () => {
    const executor: ConvexInstallationExecutor = {
      async query() {
        return [{
          descriptor: {
            ...descriptor,
            trust: { ...descriptor.trust, deploymentId: "another-deployment" },
          },
          revision: 1,
        }]
      },
      async mutation() {
        throw new Error("not used")
      },
    }
    await expect(
      new ConvexServiceInstallationStore(executor).list({ environmentId: "staging", deploymentId: "deployment-1" }),
    ).rejects.toThrow(/deployment scope/)
  })
})
