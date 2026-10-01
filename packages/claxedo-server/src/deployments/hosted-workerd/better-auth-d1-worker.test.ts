import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  compose: vi.fn(),
  authHandler: vi.fn(),
  coreFetch: vi.fn(),
}))

vi.mock("../../authority/adapters/worker/better-auth-d1-compose", () => ({
  composeBetterAuthD1UserDeployedControlPlane: mocks.compose,
}))
vi.mock("../../platform/auth/better-auth-configuration", () => ({
  resolveBetterAuthConfiguration: () => ({
    public: { apiOrigin: "https://api.example.test", appOrigin: "https://app.example.test", methods: ["github"] },
    private: { socialProviders: { github: { clientId: "client" } } },
  }),
}))
vi.mock("./core-worker.cf", () => ({
  LiveSyncRoom: class LiveSyncRoom { readonly stub = "live-sync-room" },
  createHostedCoreWorker: (compose: (env: unknown) => unknown) => ({
    fetch: async (request: Request, env: unknown, context: unknown) => {
      compose(env)
      return mocks.coreFetch(request, env, context)
    },
  }),
}))

import worker, { betterAuthD1CompositionInput, createBetterAuthD1Worker } from "./better-auth-d1-worker.cf"
import { createFixedWindowConnectionRateLimiter } from "../../platform/auth/rate-limit"

function env() {
  return {
    AUTH_DB: {} as never,
    CONTROL_PLANE_DB: {} as never,
    CF_VERSION_METADATA: { id: "11111111-1111-1111-1111-111111111111", tag: "claxedo-0123abcd" },
    CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID: "org_deployment",
    CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME: "My deployment",
    CLAXEDO_APP_ORIGIN: "https://app.example.test",
  }
}

describe("Better Auth D1 Worker", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authHandler.mockImplementation(async () => Response.json({ auth: true }))
    mocks.coreFetch.mockImplementation(async () => Response.json({ core: true }))
    mocks.compose.mockReturnValue({
      plane: {},
      options: {},
      authHandler: mocks.authHandler,
      authReady: Promise.resolve(),
    })
  })

  test("reports the serving Cloudflare version on /health without composing", async () => {
    const response = await worker.fetch(new Request("https://api.example.test/health"), env())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: "ok",
      platformVersionId: "11111111-1111-1111-1111-111111111111",
      platformVersionTag: "claxedo-0123abcd",
    })
    expect(mocks.compose).not.toHaveBeenCalled()
  })

  test("dispatches auth routes to Better Auth and every other route to the core app", async () => {
    const auth = await worker.fetch(new Request("https://api.example.test/api/auth/get-session"), env())
    expect(await auth.json()).toEqual({ auth: true })
    const product = await worker.fetch(new Request("https://api.example.test/api/claxedo/mode"), env())
    expect(await product.json()).toEqual({ core: true })
    expect(mocks.authHandler).toHaveBeenCalledTimes(1)
    expect(mocks.coreFetch).toHaveBeenCalledTimes(1)
  })

  test("refuses a request for another origin before composing", async () => {
    const response = await worker.fetch(new Request("https://other.example.test/api/claxedo/mode"), env())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: "deployment_candidate_unavailable" } })
    expect(mocks.compose).not.toHaveBeenCalled()
  })

  test("a composition failure answers the app origin with CORS so the browser can read the 503", async () => {
    mocks.compose.mockImplementation(() => {
      throw new Error("CLAXEDO_AUTH_CONFIGURATION_ID is required")
    })
    const response = await worker.fetch(
      new Request("https://api.example.test/api/claxedo/mode", { headers: { origin: "https://app.example.test" } }),
      env(),
    )
    expect(response.status).toBe(503)
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.test")
    expect(response.headers.get("access-control-allow-credentials")).toBe("true")

    const preflight = await worker.fetch(
      new Request("https://api.example.test/api/claxedo/mode", {
        method: "OPTIONS",
        headers: { origin: "https://app.example.test" },
      }),
      env(),
    )
    expect(preflight.status).toBe(204)

    const foreign = await worker.fetch(
      new Request("https://api.example.test/api/claxedo/mode", { headers: { origin: "https://evil.example.test" } }),
      env(),
    )
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("refuses to compose without the one-organization identity", () => {
    expect(() =>
      betterAuthD1CompositionInput({ ...env(), CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME: " " }),
    ).toThrow(/CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME is required/)
    const input = betterAuthD1CompositionInput(env())
    expect(input.product.organization).toEqual({ id: "org_deployment", name: "My deployment" })
    expect(input.descriptorExpiresAt).toBeGreaterThan(Date.now())
  })

  describe("public-auth budget", () => {
    function limitedWorker(limit: number) {
      return createBetterAuthD1Worker({
        composition: mocks.compose,
        publicAuthRateLimiter: createFixedWindowConnectionRateLimiter({ limit, windowMs: 60_000 }),
      })
    }

    test("keys auth requests on the trusted client IP, so a varying spoofed x-forwarded-for buys no fresh budget", async () => {
      const shared = vi.fn(async (_input: { key: string }) => ({ success: true }))
      const workerInstance = limitedWorker(3)
      const limitedEnv = { ...env(), CLAXEDO_REQUEST_LIMITER: { limit: shared } }
      const send = (xff: string, ip = "198.51.100.9") =>
        workerInstance.fetch(
          new Request("https://api.example.test/api/auth/get-session", {
            headers: { "cf-connecting-ip": ip, "x-forwarded-for": xff },
          }),
          limitedEnv,
        )

      for (const xff of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
        expect((await send(xff)).status).toBe(200)
      }
      const denied = await send("203.0.113.4")
      expect(denied.status).toBe(429)
      expect(denied.headers.get("retry-after")).toBeTruthy()
      expect(await denied.json()).toMatchObject({ error: { code: "rate_limited" } })
      expect(mocks.authHandler).toHaveBeenCalledTimes(3)
      expect(shared.mock.calls.map(([input]) => input.key)).toEqual([
        "public-auth:198.51.100.9",
        "public-auth:198.51.100.9",
        "public-auth:198.51.100.9",
      ])
      expect((await send("203.0.113.4", "203.0.113.7")).status).toBe(200)
    })

    test("a shared-store rejection denies auth dispatch while the local fuse still has room", async () => {
      const workerInstance = limitedWorker(600)
      const limitedEnv = {
        ...env(),
        CLAXEDO_REQUEST_LIMITER: { limit: async () => ({ success: false }) },
      }
      const response = await workerInstance.fetch(
        new Request("https://api.example.test/api/auth/get-session", {
          headers: { "cf-connecting-ip": "198.51.100.9" },
        }),
        limitedEnv,
      )
      expect(response.status).toBe(429)
      expect(mocks.authHandler).not.toHaveBeenCalled()
    })

    test("the budget answers before composition, so auth floods are bounded while composition fails too", async () => {
      mocks.compose.mockImplementation(() => {
        throw new Error("composition unavailable")
      })
      const workerInstance = limitedWorker(1)
      const send = () =>
        workerInstance.fetch(
          new Request("https://api.example.test/api/auth/sign-in/social", {
            method: "POST",
            headers: { "cf-connecting-ip": "203.0.113.7" },
          }),
          env(),
        )

      expect((await send()).status).toBe(503)
      const denied = await send()
      expect(denied.status).toBe(429)
      expect(await denied.json()).toMatchObject({ error: { code: "rate_limited" } })
      expect(mocks.authHandler).not.toHaveBeenCalled()
    })
  })
})
