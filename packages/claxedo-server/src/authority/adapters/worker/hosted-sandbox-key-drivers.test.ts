import { describe, expect, test } from "vitest"
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
