import { describe, expect, test } from "vitest"
import { hostedSandboxDriver, lifecycleMinutes, sandboxRuntimeControlEnv } from "./hosted-sandbox-driver"

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

  test("daytona needs a key and a snapshot; exe needs a token; an unknown name is refused", () => {
    expect(hostedSandboxDriver({ ...plane, CLAXEDO_SANDBOX_DRIVER: "daytona", DAYTONA_API_KEY: "k" })).toBeUndefined()
    expect(hostedSandboxDriver({
      ...plane,
      CLAXEDO_SANDBOX_DRIVER: "daytona",
      DAYTONA_API_KEY: "k",
      CLAXEDO_DAYTONA_SNAPSHOT: "claxedo-workspace-runtime-0-5-2-v8",
    })?.id).toBe("daytona")
    expect(hostedSandboxDriver({ ...plane, CLAXEDO_SANDBOX_DRIVER: "exe" })).toBeUndefined()
    expect(hostedSandboxDriver({ ...plane, CLAXEDO_SANDBOX_DRIVER: "exe", EXE_DEV_API_TOKEN: "t" })?.id).toBe("exe")
    expect(() => hostedSandboxDriver({ ...plane, CLAXEDO_SANDBOX_DRIVER: "modal" })).toThrow(/must be one of/)
  })

  test("lifecycle knobs round to whole minutes with a floor of one", () => {
    expect(lifecycleMinutes({}, "CLAXEDO_SANDBOX_AUTO_STOP_MS", 30 * 60_000)).toBe(30)
    expect(lifecycleMinutes({ CLAXEDO_SANDBOX_AUTO_STOP_MS: "1000" }, "CLAXEDO_SANDBOX_AUTO_STOP_MS", 30 * 60_000)).toBe(1)
  })
})
