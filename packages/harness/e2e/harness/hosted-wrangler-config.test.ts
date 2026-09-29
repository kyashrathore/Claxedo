import { expect, test } from "bun:test"
import { renderHostedE2eWranglerConfig } from "./hosted-wrangler-config"

test("local hosted config is the certified full-hosted artifact", () => {
  const { production, e2e } = renderHostedE2eWranglerConfig()
  expect(production).toContain('main = "../src/deployments/hosted-workerd/better-auth-d1-worker.agent-plugins.full-hosted.cf.ts"')
  expect(production).toContain('compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]')
  expect(e2e).toBe(production)
})
