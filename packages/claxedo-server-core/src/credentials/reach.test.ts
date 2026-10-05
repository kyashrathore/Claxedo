import { expect, test } from "vitest"
import { credentialReach } from "./reach"

test("a harness inside a cloud workspace spends an account only where the driver brokers it, or where the account is handed over itself", () => {
  const key = { provider_id: "claude-sdk", kind: "api_key" as const }
  expect(credentialReach(key)).toEqual({ local: true, cloud: true })
  expect(credentialReach(key, "native")).toEqual({ local: true, cloud: true, cloudHarness: true })
  expect(credentialReach(key, "none")).toEqual({ local: true, cloud: true, cloudHarness: false })
  expect(credentialReach({ provider_id: "codex-app-server", kind: "oauth_token" }, "none")).toMatchObject({ cloud: true, cloudHarness: true })
})
