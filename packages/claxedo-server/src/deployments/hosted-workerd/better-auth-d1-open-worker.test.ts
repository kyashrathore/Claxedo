import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  compose: vi.fn(),
  coreFetch: vi.fn(),
  authHandler: vi.fn(),
  releaseIdentity: vi.fn(),
  releaseState: vi.fn(),
  pairedRecovery: vi.fn(),
}))

vi.mock("../../authority/adapters/worker/better-auth-d1-compose", () => ({
  composeBetterAuthD1UserDeployedControlPlane: mocks.compose,
}))
vi.mock("./core-worker.cf", () => ({
  LiveSyncRoom: class LiveSyncRoom {},
  createHostedCoreWorker: (compose: (env: unknown) => unknown) => ({
    fetch: async (request: Request, env: unknown, context: unknown) => {
      compose(env)
      return mocks.coreFetch(request, env, context)
    },
  }),
}))
vi.mock("../../platform/auth/better-auth-configuration", () => ({
  resolveBetterAuthConfiguration: () => ({
    public: { apiOrigin: "https://api.example.test", appOrigin: "https://app.example.test", methods: ["github"] },
    private: { socialProviders: { github: { clientId: "client" } } },
  }),
}))
vi.mock("./better-auth-d1-release-identity.cf", () => ({
  requiredReleaseIdentifier: (value: string | undefined, name: string) => {
    if (!value?.trim()) throw new Error(`${name} is required`)
    return value.trim()
  },
  betterAuthD1ReleaseIdentity: mocks.releaseIdentity,
}))
vi.mock("./better-auth-d1-release-state.cf", () => ({
  requireDeploymentReleaseState: mocks.releaseState,
}))
vi.mock("./paired-d1-recovery.cf", () => ({
  requirePairedD1RecoveryEpoch: mocks.pairedRecovery,
}))

import worker from "./better-auth-d1-open-worker.cf"

function env() {
  return {
    AUTH_DB: {} as never,
    CONTROL_PLANE_DB: {} as never,
    CLAXEDO_RECOVERY_EPOCH: "paired-d1-v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    CLAXEDO_BROWSER_BUILD_ID: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    CLAXEDO_RELAY_BUILD_ID: "relay-absent-v1",
    CLAXEDO_AUTH_DESCRIPTOR_EXPIRES_AT: String(Date.now() + 86_400_000),
    CLAXEDO_ENVIRONMENT_ID: "production",
    CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID: "org_deployment",
    CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME: "My deployment",
  }
}

const identity = {
  deploymentId: "deployment-1",
  releaseId: "release-1",
}

describe("open Better Auth D1 Worker", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.releaseIdentity.mockResolvedValue(identity)
    mocks.releaseState.mockResolvedValue({ ...identity, phase: "open" })
    mocks.pairedRecovery.mockResolvedValue({})
    mocks.authHandler.mockResolvedValue(Response.json({ auth: true }))
    mocks.coreFetch.mockResolvedValue(Response.json({ core: true }))
    mocks.compose.mockReturnValue({
      plane: {},
      options: {},
      authHandler: mocks.authHandler,
    })
  })

  test("refuses ordinary traffic unless the exact release is open", async () => {
    mocks.releaseState.mockResolvedValue({ ...identity, phase: "multiplayer_validation" })
    const response = await worker.fetch(new Request("https://api.example.test/api/claxedo/health"), env())

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: "deployment_unavailable" } })
    expect(mocks.pairedRecovery).not.toHaveBeenCalled()
    expect(mocks.compose).not.toHaveBeenCalled()
    expect(mocks.coreFetch).not.toHaveBeenCalled()
  })

  test("checks paired recovery before dispatching Better Auth protocol routes", async () => {
    const bindings = env()
    const request = new Request("https://api.example.test/api/auth/sign-in/social", { method: "POST" })
    const response = await worker.fetch(request, bindings)

    expect(await response.json()).toEqual({ auth: true })
    expect(mocks.releaseState).toHaveBeenCalledWith(bindings.AUTH_DB, identity)
    expect(mocks.pairedRecovery).toHaveBeenCalledWith(bindings.AUTH_DB, bindings.CONTROL_PLANE_DB, {
      deploymentId: identity.deploymentId,
      releaseId: identity.releaseId,
      recoveryEpoch: bindings.CLAXEDO_RECOVERY_EPOCH,
    })
    expect(mocks.authHandler).toHaveBeenCalledWith(request)
    expect(mocks.coreFetch).not.toHaveBeenCalled()
  })

  test("dispatches product requests only after both durable gates pass", async () => {
    const bindings = env()
    const request = new Request("https://api.example.test/api/claxedo/health")
    const response = await worker.fetch(request, bindings)

    expect(await response.json()).toEqual({ core: true })
    expect(mocks.pairedRecovery).toHaveBeenCalledTimes(1)
    expect(mocks.coreFetch).toHaveBeenCalledWith(request, bindings, undefined)
    expect(mocks.authHandler).not.toHaveBeenCalled()
  })

  test("fails closed on a recovery mismatch or an unexpected request origin", async () => {
    mocks.pairedRecovery.mockRejectedValueOnce(new Error("recovery mismatch"))
    expect((await worker.fetch(new Request("https://api.example.test/api/claxedo/health"), env())).status).toBe(503)
    expect((await worker.fetch(new Request("https://other.example.test/api/claxedo/health"), env())).status).toBe(503)
    expect(mocks.coreFetch).not.toHaveBeenCalled()
  })
})
