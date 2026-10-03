import { afterEach, describe, expect, test, vi } from "vitest"
import { hostedSandboxDriver, sandboxRuntimeControlEnv } from "./hosted-sandbox-driver"

const plane = {
  BETTER_AUTH_URL: "https://api.example.test",
  CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.example.test/",
  CLAXEDO_RELAY_HOST_VERIFY_PEM: "-----BEGIN PUBLIC KEY-----\nrelay\n-----END PUBLIC KEY-----",
}
afterEach(() => vi.unstubAllGlobals())

describe("hosted sandbox driver selection", () => {
  test("supplies the producer environment at the actual Cloudflare host and lease epoch", async () => {
    const requests: { env: Record<string, string> }[] = []
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string))
      return Response.json({ ready: true, url: "https://sandbox.example.test/proxy" })
    }))
    const runtimeEnv = vi.fn(async () => ({ WORKSPACE_RUNTIME_SESSION_ROWS_TOKEN: "producer-pass" }))
    const driver = hostedSandboxDriver({ ...plane, CLAXEDO_SANDBOX_DRIVER: "cloudflare", CLOUDFLARE_SANDBOX_WORKER_URL: "https://sandbox.example.test", CLOUDFLARE_SANDBOX_API_TOKEN: "sandbox-token" }, { runtimeEnv })!
    const launch = { workspaceId: "ws_cloud", homeRegion: "us-east" as const, epoch: 7, labels: {} }
    await driver.ensureHost(launch)
    expect(runtimeEnv).toHaveBeenCalledWith(launch, { id: "claxedo-ws_cloud" })
    expect(requests[0].env).toMatchObject({ WORKSPACE_RUNTIME_HOST_ID: "claxedo-ws_cloud", WORKSPACE_RUNTIME_SESSION_ROWS_TOKEN: "producer-pass", WORKSPACE_RUNTIME_MANAGEMENT_AUDIENCE: "supervisor-backplane" })
  })
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

  test("the fetch bridge needs its URL, and a driver it does not compose is refused", () => {
    expect(hostedSandboxDriver({ ...plane, CLAXEDO_SANDBOX_DRIVER: "fetch" })).toBeUndefined()
    expect(hostedSandboxDriver({ ...plane, CLAXEDO_SANDBOX_DRIVER: "fetch", CLAXEDO_SANDBOX_DRIVER_URL: "https://driver.example.test" })?.id).toBe("fetch")
    expect(() => hostedSandboxDriver({ ...plane, CLAXEDO_SANDBOX_DRIVER: "modal" })).toThrow(/must be cloudflare or fetch/)
  })
})
