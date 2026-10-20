import { expect, test } from "bun:test"
import { renderHostedE2eWranglerConfig } from "./hosted-wrangler-config"

test("local hosted config is the certified full-hosted artifact", () => {
  const { production, e2e } = renderHostedE2eWranglerConfig("../migrations/control-plane", "claxedo-e2e.localhost")
  expect(production).toContain('main = "../src/deployments/hosted-workerd/better-auth-d1-worker.agent-plugins.full-hosted.cf.ts"')
  expect(production).toContain('compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public", "enable_ctx_exports"]')
  expect(production).toContain('"claxedo-e2e.localhost/api/*"')
  expect(e2e).toBe(production)
})
