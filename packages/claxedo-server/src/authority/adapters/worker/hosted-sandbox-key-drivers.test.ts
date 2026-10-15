import { formatBoatRuntimeTemplate } from "@claxedo/sandbox-manager/drivers/boat"
import { describe, expect, test, vi } from "vitest"
import { hostedSandboxKeyDriverIds, hostedSandboxKeyDrivers, sandboxRuntimeControlEnv } from "./hosted-sandbox-key-drivers"

const plane = {
  BETTER_AUTH_URL: "https://api.example.test",
  CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.example.test/",
  CLAXEDO_RELAY_HOST_VERIFY_PEM: "-----BEGIN PUBLIC KEY-----\nrelay\n-----END PUBLIC KEY-----",
  CLAXEDO_SANDBOX_IMAGE: "ghcr.io/example/sandbox:1",
}

describe("the drivers an organization key builds on a Worker", () => {
  test("every catalog driver that runs in a Worker is offered, and nothing else is built", () => {
    const keys = hostedSandboxKeyDrivers(plane)
    expect(keys.drivers).toEqual(["cloudflare", "boat"])
    expect(keys.drivers).toBe(hostedSandboxKeyDriverIds)
    expect(keys.create("vercel", { access_token: "t", team_id: "t", project_id: "p" })).toBeUndefined()
    expect(keys.create("modal", { token_id: "t", token_secret: "s" })).toBeUndefined()
  })

  test("a Cloudflare key needs its Worker URL and token, a Boat key its API key, each with the plane-derived control env", () => {
    const keys = hostedSandboxKeyDrivers(plane)
    expect(keys.create("cloudflare", { worker_url: "https://sandbox.example.test" })).toBeUndefined()
    expect(keys.create("cloudflare", { api_token: "sandbox-token" })).toBeUndefined()
    expect(keys.create("cloudflare", { worker_url: "https://sandbox.example.test", api_token: "sandbox-token" })?.id).toBe("cloudflare")
    expect(keys.create("boat", {})).toBeUndefined()
    expect(keys.create("boat", { api_key: "boat-key" })?.id).toBe("boat")
  })

  test("a full-hosted Worker without the runtime image refuses to compose, since every Boat key would boot it", () => {
    const { CLAXEDO_SANDBOX_IMAGE: _image, ...withoutImage } = plane
    expect(() => hostedSandboxKeyDrivers(withoutImage)).toThrow(/CLAXEDO_SANDBOX_IMAGE/)
    expect(() => hostedSandboxKeyDrivers({ ...plane, CLAXEDO_SANDBOX_IMAGE: "  " })).toThrow(/CLAXEDO_SANDBOX_IMAGE/)
  })

  test("a Boat key's driver creates a sandbox of the deployment's image from the release's runtime template", async () => {
    const creates: unknown[] = []
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith("/sandboxes") && typeof init?.body === "string") creates.push(JSON.parse(init.body))
      return Response.json({ ok: false, code: "unauthorized" }, { status: 401 })
    })
    try {
      const template = formatBoatRuntimeTemplate({ image: plane.CLAXEDO_SANDBOX_IMAGE, shareCode: "bsh_release" })
      const driver = hostedSandboxKeyDrivers({ ...plane, CLAXEDO_BOAT_RUNTIME_TEMPLATE: template }).create("boat", { api_key: "boat-key" })
      await expect(driver?.ensureHost({ workspaceId: "ws1", homeRegion: "auto", epoch: 1, labels: {} })).rejects.toThrow("(unauthorized)")
      expect(creates).toEqual([{ noEnv: true, ttlSeconds: 1800, from: "bsh_release" }])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("a runtime template setting the Worker cannot read refuses composition", () => {
    expect(() => hostedSandboxKeyDrivers({ ...plane, CLAXEDO_BOAT_RUNTIME_TEMPLATE: "bsh_release" })).toThrow(/CLAXEDO_BOAT_RUNTIME_TEMPLATE/)
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
})
