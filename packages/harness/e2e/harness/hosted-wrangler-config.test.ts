import { expect, test } from "bun:test"
import { renderHostedE2eWranglerConfig } from "./hosted-wrangler-config"

test("local hosted config differs from the certified full-hosted artifact only in private fetch", () => {
  const { production, e2e } = renderHostedE2eWranglerConfig()
  expect(production).toContain('main = "../src/deployments/hosted-workerd/better-auth-d1-candidate-worker.agent-plugins.full-hosted.cf.ts"')
  expect(production).toContain('compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]')
  expect(e2e).toContain('compatibility_flags = ["nodejs_compat"]')
  expect(e2e.replace('compatibility_flags = ["nodejs_compat"]', 'compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]')).toBe(production)
})
