import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  compose: vi.fn(),
  authenticate: vi.fn(),
  verifyIdentity: vi.fn(),
  authHandler: vi.fn(),
  coreFetch: vi.fn(),
  releaseIdentity: vi.fn(),
  releaseState: vi.fn(),
  releaseCandidate: vi.fn(),
  pairedRecovery: vi.fn(),
  operatorResponse: vi.fn(),
  recordFirstWrite: vi.fn(),
  admitOperation: vi.fn(),
  canaryAdmission: vi.fn(),
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
vi.mock("../../platform/auth/better-auth-native-clients", () => ({
  requireBetterAuthDatabaseSchema: vi.fn(),
  requireBetterAuthNativeClientClosure: vi.fn(),
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
  cloudflarePlatformVersion: () => ({ id: "11111111-1111-1111-1111-111111111111", tag: "cutover-v1" }),
}))
vi.mock("./better-auth-d1-release-state.cf", () => ({
  requireDeploymentReleaseState: mocks.releaseState,
  requireDeploymentReleaseCandidateAtRevision: mocks.releaseCandidate,
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
  requireDeploymentCanaryAdmission: mocks.canaryAdmission,
}))

import worker from "./better-auth-d1-candidate-worker.cf"

const identity = { deploymentId: "deployment-1", releaseId: "release-1" }
const canaryIdentityHash = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
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
    CLAXEDO_CANARY_JOURNEY_ID: "journey-12345678",
    CLAXEDO_CANDIDATE_STATE_REVISION: "0",
    CLAXEDO_CANDIDATE_OPERATION_ID: "initialize:release-1",
    BETTER_AUTH_SECRET: "better-auth-secret-long-enough",
    CLAXEDO_AUTH_INTROSPECTION_SECRET: "introspection-secret-long-enough",
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
    mocks.releaseCandidate.mockResolvedValue({ ...release("locked"), workerBuildId: "sha256:worker" })
    mocks.pairedRecovery.mockResolvedValue({})
    mocks.operatorResponse.mockResolvedValue(undefined)
    mocks.authHandler.mockImplementation(async () => Response.json({ auth: true }))
    mocks.coreFetch.mockImplementation(async () => Response.json({ core: true }))
    mocks.authenticate.mockImplementation(async () => {
      mocks.events.push("authenticate")
      return principal
    })
    mocks.verifyIdentity.mockResolvedValue(principal.identity)
    mocks.identityHash.mockResolvedValue(canaryIdentityHash)
    mocks.canaryAdmission.mockResolvedValue({
      canaryIdentityHash,
      journeyId: env().CLAXEDO_CANARY_JOURNEY_ID,
    })
    mocks.recordFirstWrite.mockImplementation(async () => {
      mocks.events.push("first-write")
      return { ...release("canary"), stateRevision: 5, phaseRevision: 2, firstTargetWriteAt: "now" }
    })
    mocks.admitOperation.mockResolvedValue({ allowed: true })
    mocks.compose.mockReturnValue({
      plane: {},
      options: { authentication: { authenticate: mocks.authenticate } },
      authHandler: mocks.authHandler,
      verifyIdentity: mocks.verifyIdentity,
      authReady: Promise.resolve(),
    })
  })

  test("certifies a registered zero-traffic candidate before requiring it to be active", async () => {
    const response = await worker.fetch(new Request("https://api.example.test/__release/candidate-health"), env())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: "candidate-locked",
      platformVersionId: "11111111-1111-1111-1111-111111111111",
      release: { releaseId: "release-1", workerBuildId: "sha256:worker" },
    })
    expect(mocks.releaseCandidate).toHaveBeenCalledTimes(1)
    expect(mocks.releaseState).not.toHaveBeenCalled()
  })

  test("denies auth and every ordinary product request while locked", async () => {
    const auth = await worker.fetch(new Request("https://api.example.test/api/auth/sign-in/social"), env())
    expect(auth.status).toBe(503)
    expect(await auth.json()).toEqual({ error: { code: "deployment_phase_denied" } })
    const ordinary = await worker.fetch(new Request("https://api.example.test/api/claxedo/health"), env())
    expect(ordinary.status).toBe(503)
    expect(await ordinary.json()).toEqual({ error: { code: "deployment_phase_denied" } })
    expect(mocks.authenticate).not.toHaveBeenCalled()
    expect(mocks.coreFetch).not.toHaveBeenCalled()
  })

  test("discovers the canonical canary identity only through the release-bound locked enrollment journey", async () => {
    const headers = { "x-claxedo-canary-journey-id": env().CLAXEDO_CANARY_JOURNEY_ID }
    const auth = await worker.fetch(
      new Request("https://api.example.test/api/auth/sign-in/social", { method: "POST", headers }),
      env(),
    )
    expect(await auth.json()).toEqual({ auth: true })
    const discovered = await worker.fetch(
      new Request("https://api.example.test/__release/canary/identity", { headers }),
      env(),
    )
    expect(await discovered.json()).toEqual({ identity: principal.identity, identityHash: canaryIdentityHash })
    expect(mocks.verifyIdentity).toHaveBeenCalledOnce()
    expect(mocks.authenticate).not.toHaveBeenCalled()
  })

  test("admits auth through the bound canary journey and lets multiplayer users establish identity", async () => {
    mocks.releaseState.mockResolvedValue(release("canary"))
    const canaryDenied = await worker.fetch(
      new Request("https://api.example.test/api/auth/sign-in/social", { method: "POST" }),
      env(),
    )
    expect(await canaryDenied.json()).toEqual({ error: { code: "canary_journey_denied" } })
    const canaryAuth = await worker.fetch(
      new Request("https://api.example.test/api/auth/sign-in/social", {
        method: "POST",
        headers: { "x-claxedo-canary-journey-id": env().CLAXEDO_CANARY_JOURNEY_ID },
      }),
      env(),
    )
    expect(await canaryAuth.json()).toEqual({ auth: true })

    mocks.releaseState.mockResolvedValue(release("multiplayer_validation"))
    const validationAuth = await worker.fetch(new Request("https://api.example.test/api/auth/get-session"), env())
    expect(await validationAuth.json()).toEqual({ auth: true })
  })

  test("multiplayer validation exposes only OAuth bootstrap, health, and CORS preflight without operation admission", async () => {
    mocks.releaseState.mockResolvedValue(release("multiplayer_validation"))

    const descriptor = await worker.fetch(
      new Request("https://api.example.test/api/claxedo/auth/descriptor"),
      env(),
    )
    expect(await descriptor.json()).toEqual({ core: true })

    const health = await worker.fetch(
      new Request("https://api.example.test/api/claxedo/health"),
      env(),
    )
    expect(await health.json()).toEqual({ core: true })

    const preflight = await worker.fetch(
      new Request("https://api.example.test/api/auth/sign-in/social", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.test",
          "access-control-request-method": "GET",
          "access-control-request-headers": "x-claxedo-multiplayer-validation-operation",
        },
      }),
      env(),
    )
    expect(await preflight.json()).toEqual({ auth: true })

    const product = await worker.fetch(new Request("https://api.example.test/api/claxedo/auth/profile"), env())
    expect(await product.json()).toEqual({ error: { code: "multiplayer_validation_operation_denied" } })
    expect(mocks.authenticate).not.toHaveBeenCalled()
    expect(mocks.admitOperation).not.toHaveBeenCalled()
    expect(mocks.authHandler).toHaveBeenCalledTimes(1)
    expect(mocks.coreFetch).toHaveBeenCalledTimes(2)
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

  test("provider sync admits only operator paths and the same candidate bytes serve auth and core at open", async () => {
    mocks.releaseState.mockResolvedValue(release("provider_sync"))
    mocks.operatorResponse.mockResolvedValueOnce(Response.json({ operator: true }))
    expect(
      await (await worker.fetch(new Request("https://api.example.test/__release/operator/status"), env())).json(),
    ).toEqual({ operator: true })
    expect((await worker.fetch(new Request("https://api.example.test/api/claxedo/health"), env())).status).toBe(503)

    mocks.releaseState.mockResolvedValue(release("open"))
    const auth = await worker.fetch(new Request("https://api.example.test/api/auth/session"), env())
    expect(await auth.json()).toEqual({ auth: true })
    const product = await worker.fetch(new Request("https://api.example.test/api/claxedo/health"), env())
    expect(await product.json()).toEqual({ core: true })
  })

  test("multiplayer validation delegates exact identity and operation admission before core", async () => {
    mocks.releaseState.mockResolvedValue(release("multiplayer_validation"))
    const request = new Request("https://api.example.test/api/claxedo/auth/profile", {
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

  test("multiplayer validation separates the browser identity from the runtime authority bearer credential", async () => {
    mocks.releaseState.mockResolvedValue(release("multiplayer_validation"))
    const request = new Request("https://api.example.test/api/runtime-authority/session-authorize", {
      method: "POST",
      headers: {
        authorization: "Bearer relay-host-token",
        cookie: "better-auth.session_token=owner-session",
        "x-claxedo-multiplayer-validation-operation": "private_session",
      },
      body: JSON.stringify({ sessionId: "ses_1", action: "register", operationId: "op_1" }),
    })

    expect((await worker.fetch(request, env())).status).toBe(200)
    const authenticationRequest = mocks.authenticate.mock.calls[0]?.[0] as Request
    expect(authenticationRequest.headers.get("authorization")).toBeNull()
    expect(authenticationRequest.headers.get("cookie")).toBe("better-auth.session_token=owner-session")
    const dispatchedRequest = mocks.coreFetch.mock.calls[0]?.[0] as Request
    expect(dispatchedRequest.headers.get("authorization")).toBe("Bearer relay-host-token")
    expect(await dispatchedRequest.json()).toEqual({ sessionId: "ses_1", action: "register", operationId: "op_1" })
  })

  test("multiplayer validation lets the relay reach its service-token-gated resolver routes", async () => {
    mocks.releaseState.mockResolvedValue(release("multiplayer_validation"))
    const request = new Request(
      "https://api.example.test/internal/relay/revocation?jti=jti_1&workspaceId=ws_1&hostId=host_1",
      { headers: { authorization: "Bearer relay-resolver-token" } },
    )

    expect((await worker.fetch(request, env())).status).toBe(200)
    expect(mocks.authenticate).not.toHaveBeenCalled()
    expect(mocks.admitOperation).not.toHaveBeenCalled()
    expect(mocks.coreFetch).toHaveBeenCalledTimes(1)
  })

  test("discovers a second provider identity before application admission during multiplayer validation", async () => {
    mocks.releaseState.mockResolvedValue(release("multiplayer_validation"))
    mocks.admitOperation.mockRejectedValueOnce(
      new Error("multiplayer request identity is not one of the two release-bound identities"),
    )
    const request = new Request("https://api.example.test/__release/multiplayer/identity", {
      headers: { "x-claxedo-multiplayer-validation-operation": "private_session" },
    })
    const response = await worker.fetch(request, env())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ identity: principal.identity, identityHash: canaryIdentityHash })
    expect(mocks.verifyIdentity).toHaveBeenCalledOnce()
    expect(mocks.authenticate).not.toHaveBeenCalled()
    // This endpoint is the discovery seam used to obtain the hash that the
    // operator registers. Requiring that receipt here creates an impossible
    // hash-before-hash cycle; ordinary product requests remain receipt-gated.
    expect(mocks.admitOperation).not.toHaveBeenCalled()
  })
})
