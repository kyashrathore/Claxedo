import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  compose: vi.fn(),
  authenticate: vi.fn(),
  authHandler: vi.fn(),
  coreFetch: vi.fn(),
  releaseIdentity: vi.fn(),
  releaseState: vi.fn(),
  pairedRecovery: vi.fn(),
  operatorResponse: vi.fn(),
  recordFirstWrite: vi.fn(),
  admitOperation: vi.fn(),
  identityHash: vi.fn(),
  events: [] as string[],
}))

vi.mock("../../authority/adapters/worker/better-auth-d1-compose", () => ({
  composeBetterAuthD1UserDeployedControlPlane: mocks.compose,
}))
vi.mock("../../authority/adapters/d1/workspace-authority", () => ({
  USER_DEPLOYED_OWNER_CLAIM_HEADER: "x-claxedo-bootstrap-owner-claim",
  userDeployedOwnerIdentityHash: mocks.identityHash,
}))
vi.mock("../../platform/auth/better-auth-configuration", () => ({
  resolveBetterAuthConfiguration: () => ({
    public: { apiOrigin: "https://api.example.test", appOrigin: "https://app.example.test", methods: ["github"] },
    private: { socialProviders: { github: { clientId: "client" } } },
  }),
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
vi.mock("./better-auth-d1-operator.cf", () => ({
  assertOperatorSecretIsolation: vi.fn(),
  operatorResponse: mocks.operatorResponse,
}))
vi.mock("./better-auth-d1-cutover-gate.cf", () => ({
  deploymentAdmissionBinding: (release: unknown) => release,
  recordDeploymentCanaryFirstWrite: mocks.recordFirstWrite,
  admitDeploymentOperation: mocks.admitOperation,
}))

import worker from "./better-auth-d1-candidate-worker.cf"

const identity = { deploymentId: "deployment-1", releaseId: "release-1" }
const principal = {
  identity: { adapter: "better-auth", issuer: "https://api.example.test/api/auth", subject: "user-1" },
}

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
    CLAXEDO_CANARY_IDENTITY_HASH: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    CLAXEDO_CANARY_JOURNEY_ID: "journey-12345678",
  }
}

function release(phase: "locked" | "canary" | "provider_sync" | "multiplayer_validation" | "open") {
  return { ...identity, phase, phaseRevision: 1, stateRevision: 4, firstTargetWriteAt: null }
}

describe("Better Auth D1 candidate Worker", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.events.length = 0
    mocks.releaseIdentity.mockResolvedValue(identity)
    mocks.releaseState.mockResolvedValue(release("locked"))
    mocks.pairedRecovery.mockResolvedValue({})
    mocks.operatorResponse.mockResolvedValue(undefined)
    mocks.authHandler.mockResolvedValue(Response.json({ auth: true }))
    mocks.coreFetch.mockResolvedValue(Response.json({ core: true }))
    mocks.authenticate.mockImplementation(async () => {
      mocks.events.push("authenticate")
      return principal
    })
    mocks.identityHash.mockResolvedValue(env().CLAXEDO_CANARY_IDENTITY_HASH)
    mocks.recordFirstWrite.mockImplementation(async () => {
      mocks.events.push("first-write")
      return { ...release("canary"), stateRevision: 5, phaseRevision: 2, firstTargetWriteAt: "now" }
    })
    mocks.admitOperation.mockResolvedValue({ allowed: true })
    mocks.compose.mockReturnValue({
      plane: {},
      options: { authentication: { authenticate: mocks.authenticate } },
      authHandler: mocks.authHandler,
    })
  })

  test("allows auth while locked but denies every ordinary product request", async () => {
    expect((await worker.fetch(new Request("https://api.example.test/api/auth/sign-in/social"), env())).status).toBe(
      200,
    )
    const ordinary = await worker.fetch(new Request("https://api.example.test/api/claxedo/health"), env())
    expect(ordinary.status).toBe(503)
    expect(await ordinary.json()).toEqual({ error: { code: "deployment_phase_denied" } })
    expect(mocks.authenticate).not.toHaveBeenCalled()
    expect(mocks.coreFetch).not.toHaveBeenCalled()
  })

  test("serializes the first canary mutation before owner-claim authentication and dispatch", async () => {
    mocks.releaseState.mockResolvedValue(release("canary"))
    const request = new Request("https://api.example.test/api/control/bootstrap", {
      method: "POST",
      headers: {
        "x-claxedo-bootstrap-owner-claim": "claim",
        "x-claxedo-canary-journey-id": env().CLAXEDO_CANARY_JOURNEY_ID,
        "x-claxedo-canary-mutation-operation-id": "mutation-12345678",
      },
    })
    const response = await worker.fetch(request, env())

    expect(response.status).toBe(200)
    expect(mocks.events).toEqual(["first-write", "authenticate"])
    expect(mocks.admitOperation).toHaveBeenCalledTimes(1)
    expect(mocks.coreFetch).toHaveBeenCalledTimes(1)
  })

  test("a wrong canary identity never reaches product routes even with the bootstrap claim", async () => {
    mocks.releaseState.mockResolvedValue({ ...release("canary"), firstTargetWriteAt: "already" })
    mocks.identityHash.mockResolvedValue("sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd")
    const response = await worker.fetch(
      new Request("https://api.example.test/api/control/bootstrap", {
        method: "POST",
        headers: {
          "x-claxedo-bootstrap-owner-claim": "claim",
          "x-claxedo-canary-journey-id": env().CLAXEDO_CANARY_JOURNEY_ID,
          "x-claxedo-canary-mutation-operation-id": "mutation-12345678",
        },
      }),
      env(),
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: "canary_identity_denied" } })
    expect(mocks.admitOperation).not.toHaveBeenCalled()
    expect(mocks.coreFetch).not.toHaveBeenCalled()
  })

  test("provider sync admits only operator paths and candidate bytes retire at open", async () => {
    mocks.releaseState.mockResolvedValue(release("provider_sync"))
    mocks.operatorResponse.mockResolvedValueOnce(Response.json({ operator: true }))
    expect(
      await (await worker.fetch(new Request("https://api.example.test/__release/operator/status"), env())).json(),
    ).toEqual({ operator: true })
    expect((await worker.fetch(new Request("https://api.example.test/api/claxedo/health"), env())).status).toBe(503)

    mocks.releaseState.mockResolvedValue(release("open"))
    const retired = await worker.fetch(new Request("https://api.example.test/api/auth/session"), env())
    expect(await retired.json()).toEqual({ error: { code: "deployment_candidate_retired" } })
  })

  test("multiplayer validation delegates exact identity and operation admission before core", async () => {
    mocks.releaseState.mockResolvedValue(release("multiplayer_validation"))
    const request = new Request("https://api.example.test/api/claxedo/health", {
      headers: { "x-claxedo-multiplayer-validation-operation": "private_session" },
    })
    expect((await worker.fetch(request, env())).status).toBe(200)
    expect(mocks.admitOperation).toHaveBeenCalledWith(
      env().AUTH_DB,
      identity,
      expect.objectContaining({ operation: expect.objectContaining({ kind: "multiplayer_validation" }) }),
    )
    expect(mocks.coreFetch).toHaveBeenCalledTimes(1)
  })
})
