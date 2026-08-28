import { describe, expect, test } from "vitest"

import { SERVICE_BINDINGS, SERVICE_PROTOCOL_VERSION } from "@claxedo/service-contract"

import { renderHostedCoreOptionalServiceBindings } from "./render-optional-service-bindings"

const core = `name = "claxedo-user-deployed-core"
main = "src/deployments/hosted-workerd/better-auth-d1-open-worker.cf.ts"
[[d1_databases]]
binding = "AUTH_DB"
database_id = "auth-id"
`

function descriptor(serviceId: "workgraph" | "documents") {
  const common = {
    serviceId,
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    schemaVersion: 1,
    state: "installed_disabled" as const,
    entrypoint: serviceId === "workgraph" ? "WorkGraphServiceV1" : "DocumentsServiceV1",
    trust: {
      environmentId: "production",
      deploymentId: "deployment-1",
      bindingProvenance: `cloudflare-service:${serviceId}`,
    },
  }
  return serviceId === "workgraph"
    ? { ...common, serviceId, bindingName: SERVICE_BINDINGS.workgraph }
    : { ...common, serviceId, bindingName: SERVICE_BINDINGS.documents }
}

describe("generated core optional-service bindings", () => {
  test("keeps the base config resource-empty and adds only explicitly installed services", () => {
    expect(renderHostedCoreOptionalServiceBindings(core, [])).toBe(core)
    const installed = renderHostedCoreOptionalServiceBindings(core, [
      { descriptor: descriptor("documents"), workerName: "claxedo-documents-production" },
    ])
    expect(installed).toContain('binding = "DOCUMENTS_SERVICE"')
    expect(installed).toContain('service = "claxedo-documents-production"')
    expect(installed).toContain('entrypoint = "DocumentsServiceV1"')
    expect(installed).not.toMatch(/WORKGRAPH|DOCUMENTS_DB|DOCUMENTS_BUCKET|r2_buckets|durable_objects|crons/)
  })

  test("rejects mutation of a config that already owns optional bindings", () => {
    expect(() =>
      renderHostedCoreOptionalServiceBindings(`${core}\n[[services]]\nbinding = "DOCUMENTS_SERVICE"`, []),
    ).toThrow(/must not already contain/)
  })
})
