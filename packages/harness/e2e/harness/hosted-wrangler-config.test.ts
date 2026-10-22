import { expect, test } from "bun:test"
import { renderHostedE2eWranglerConfig } from "./hosted-wrangler-config"

test("local hosted config is the certified full-hosted artifact: one Worker with the routes by default", () => {
  const { writer, edge } = renderHostedE2eWranglerConfig("../migrations/control-plane", "claxedo-e2e.localhost", false)
  expect(writer).toContain('main = "../src/deployments/hosted-workerd/better-auth-d1-worker.agent-plugins.full-hosted.cf.ts"')
  expect(writer).toContain('"claxedo-e2e.localhost/api/*"')
  expect(writer).not.toContain("CLAXEDO_D1_EDGE_READS")
  expect(edge).toBeUndefined()
})

test("with edge reads on, the local hosted config is a writer and the edge that forwards to it", () => {
  const { writer, edge = "" } = renderHostedE2eWranglerConfig("../migrations/control-plane", "claxedo-e2e.localhost", true)
  for (const config of [writer, edge]) {
    expect(config).toContain('main = "../src/deployments/hosted-workerd/better-auth-d1-worker.agent-plugins.full-hosted.cf.ts"')
    expect(config).toContain('compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]')
  }
  expect(edge).toContain('"claxedo-e2e.localhost/api/*"')
  expect(edge).toContain('binding = "CONTROL_PLANE_WRITER"\nservice = "claxedo-hosted-e2e"')
  expect(writer).not.toContain("routes =")
  expect(writer).toContain('CLAXEDO_D1_EDGE_READS = "on"')
})
