import { describe, expect, test } from "vitest"
import { hostedSandboxDriver, sandboxRuntimeControlEnv } from "./hosted-sandbox-driver"

const plane = {
  BETTER_AUTH_URL: "https://api.example.test",
  CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.example.test/",
  CLAXEDO_RELAY_HOST_VERIFY_PEM: "-----BEGIN PUBLIC KEY-----\nrelay\n-----END PUBLIC KEY-----",
}

describe("hosted sandbox driver selection", () => {
  test("no driver selected composes nothing", () => {
    expect(hostedSandboxDriver({})).toBeUndefined()
  })

  test("the cloudflare driver needs its Worker URL and token, and gets the plane-derived control env", () => {
    expect(hostedSandboxDriver({ ...plane, CLAXEDO_SANDBOX_DRIVER: "cloudflare" })).toBeUndefined()
    expect(hostedSandboxDriver({
      ...plane,
      CLAXEDO_SANDBOX_DRIVER: "cloudflare",
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://sandbox.example.test",
    })).toBeUndefined()
    const driver = hostedSandboxDriver({
      ...plane,
      CLAXEDO_SANDBOX_DRIVER: "cloudflare",
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://sandbox.example.test",
      CLOUDFLARE_SANDBOX_API_TOKEN: "sandbox-token",
    })
    expect(driver?.id).toBe("cloudflare")
  })

  test("the boat driver needs its API key and the runtime image it boots", () => {
    const boat = { ...plane, CLAXEDO_SANDBOX_DRIVER: "boat" }
    expect(hostedSandboxDriver({ ...boat, BOAT_API_KEY: "boat-key" })).toBeUndefined()
    expect(hostedSandboxDriver({ ...boat, CLAXEDO_SANDBOX_IMAGE: "ghcr.io/example/sandbox:1" })).toBeUndefined()
    expect(hostedSandboxDriver({ ...boat, BOAT_API_KEY: "boat-key", CLAXEDO_SANDBOX_IMAGE: "ghcr.io/example/sandbox:1" })?.id).toBe("boat")
  })

  test("the control env derives every verification endpoint from what the plane already carries", () => {
    expect(sandboxRuntimeControlEnv(plane)).toEqual({
      relayJwksUrl: "https://relay.example.test/.well-known/jwks.json",
      relayVerifyPem: plane.CLAXEDO_RELAY_HOST_VERIFY_PEM,
      managementJwksUrl: "https://api.example.test/.well-known/jwks.json",
      sessionAuthorityUrl: "https://api.example.test/api/runtime-authority/session-authorize",
    })
    // A plane without a relay still verifies its own management calls.
    expect(sandboxRuntimeControlEnv({ BETTER_AUTH_URL: "https://api.example.test" })).toEqual({
      managementJwksUrl: "https://api.example.test/.well-known/jwks.json",
      sessionAuthorityUrl: "https://api.example.test/api/runtime-authority/session-authorize",
    })
  })

  test("the fetch bridge needs its URL, and a driver it does not compose is refused", () => {
    expect(hostedSandboxDriver({ ...plane, CLAXEDO_SANDBOX_DRIVER: "fetch" })).toBeUndefined()
    expect(hostedSandboxDriver({ ...plane, CLAXEDO_SANDBOX_DRIVER: "fetch", CLAXEDO_SANDBOX_DRIVER_URL: "https://driver.example.test" })?.id).toBe("fetch")
    expect(() => hostedSandboxDriver({ ...plane, CLAXEDO_SANDBOX_DRIVER: "modal" })).toThrow(/must be cloudflare, boat or fetch/)
  })
})
