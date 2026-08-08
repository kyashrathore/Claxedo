import { describe, expect, test } from "vitest"
import { defaultHomeRegion, relayEndpointsFromEnv } from "./index"

describe("Claxedo region config", () => {
  test("normalizes default home region and derives regional relay endpoints from env", () => {
    const env = {
      CLAXEDO_HOME_REGION: "eu-west",
      CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.default.test",
      CLAXEDO_WORKSPACE_RELAY_URL_EU_WEST: "https://relay.eu.test",
      CLAXEDO_WORKSPACE_RELAY_URL_APAC_SOUTH: "https://relay.apac-south.test",
    }

    expect(defaultHomeRegion(env)).toBe("eu-west")
    expect(relayEndpointsFromEnv(env, env.CLAXEDO_WORKSPACE_RELAY_URL)).toMatchObject({
      "eu-west": "https://relay.eu.test",
      "apac-south": "https://relay.apac-south.test",
      "us-east": "https://relay.default.test",
    })
  })
})
