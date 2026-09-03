import { describe, expect, test } from "vitest"

import { SERVICE_BINDINGS, SERVICE_PROTOCOL_VERSION } from "@claxedo/service-contract"

import { renderHostedCoreOptionalServiceBindings } from "./render-optional-service-bindings"

const core = `name = "claxedo-user-deployed-locked"
main = "src/deployments/hosted-workerd/better-auth-d1-candidate-worker.cf.ts"
[[d1_databases]]
binding = "AUTH_DB"
database_id = "auth-id"
`

function descriptor(serviceId: "documents") {
  return {
    serviceId,
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    schemaVersion: 1,
    state: "installed_disabled" as const,
    entrypoint: "DocumentsServiceV1",
    bindingName: SERVICE_BINDINGS.documents,
    trust: {
      environmentId: "production",
      deploymentId: "deployment-1",
      bindingProvenance: `cloudflare-service:${serviceId}`,
    },
  }
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
    expect(installed).not.toMatch(/DOCUMENTS_DB|DOCUMENTS_BUCKET|r2_buckets|durable_objects|crons/)
  })

  test("rejects mutation of a config that already owns optional bindings", () => {
    expect(() =>
      renderHostedCoreOptionalServiceBindings(`${core}\n[[services]]\nbinding = "DOCUMENTS_SERVICE"`, []),
    ).toThrow(/must not already contain/)
  })
})
