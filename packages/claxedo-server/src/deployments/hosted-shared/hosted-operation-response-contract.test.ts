import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import { SignJWT, exportJWK, exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { createHostedApp } from "./hosted-app"
import { sandboxRelayTargetLookup, type HostedControlPlane } from "../../authority/hosted-services"
import type { ControlPlaneServices } from "../../authority/services"
import type { HostEnrollment } from "@claxedo/server-core/platform/auth/authority"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import { durableCliSessionTokenRegistry } from "../../test-support/cli-session-registry"
import {
  HOSTED_OPERATIONS as OPERATION_ROUTES,
  resolveHostedOperation,
  type HostedOperationName,
} from "../../../../claxedo-desktop/src/main/account/hosted-operations"
import {
  HOSTED_OPERATIONS as OPERATION_DECODERS,
  decodeHostedResult,
} from "../../../../claxedo-app/src/platform/account/hosted-operations"

/**
 * Hosted-operation RESPONSE contract.
 *
 * `hosted-product-contract.test.ts` states the route INVENTORY: which paths a
 * hosted app serves. That is the half that was checked. The half that was not
 * is what those paths ANSWER — and three of the desktop's typed decoders were
 * wrong about exactly that for as long as they existed, past 2,800 server tests
 * and 5,100 app tests, because every test that touched a decoder fed it a
 * hand-written fixture. A fixture copied from a reading of the route agrees
 * with that reading forever, including when the route stops agreeing.
 *
 * So this file writes no response fixtures. For each of the sixteen named
 * operations it takes the METHOD and PATH from the desktop's real table
 * (`claxedo-desktop/.../account/hosted-operations.ts`), drives the REAL hosted
 * app built by `createHostedApp`, and hands the body the route actually
 * produced to the app's real decoder
 * (`claxedo-app/.../account/hosted-operations.ts`). Nothing in between is
 * transcribed. Change what a route returns and the decoder for that operation
 * fails here, named.
 *
 * The three modules are the three sides of the closed set the operation matrix
 * describes, so binding them together is also the only place all three are held
 * equal at once against a running app.
 *
 * What is still faked is everything BELOW the route — the authority, the
 * sandbox manager, the relay signer — because those are ports with their own
 * contracts and their own tests. The fakes are typed against those ports, so a
 * port whose shape changes fails to compile here rather than silently feeding
 * this suite a shape the real adapter would never send.
 */

const SUBJECT = "user_1"
const WORKSPACE_ID = "ws_1"
/** A second workspace, of the OTHER access kind, so the list rows can be told apart. */
const USER_HOSTED_WORKSPACE_ID = "ws_2"
const CHECKPOINT_ID = "cp_1"
const ISSUER = "https://clerk.operation-contract.test"
const JWKS_URL = `${ISSUER}/jwks`

/**
 * A real signed bearer, verified by the real `verifyClerkBearer`.
 *
 * The alternative — injecting `services.auth.verifier` — is what the rest of
 * the hosted suite does, and it works for the routes that thread the composed
 * verifier through. The checkpoint and lifecycle routes do not: they build
 * their auth from `services.auth.config` alone, so an injected verifier never
 * runs and every call 401s. Signing a token the production verifier accepts
 * reaches all sixteen operations through the same door a browser uses, which is
 * the only door this file is allowed to care about.
 */
const signing = {
  bearer: "",
  jwks: { keys: [] as unknown[] },
  runtimeTokenKeys: { privatePem: "", publicPem: "" },
}

const originalFetch = globalThis.fetch

beforeAll(async () => {
  const clerk = await generateKeyPair("ES256", { extractable: true })
  const runtime = await generateKeyPair("EdDSA", { extractable: true })
  signing.jwks = { keys: [{ ...(await exportJWK(clerk.publicKey)), kid: "contract-key", alg: "ES256", use: "sig" }] }
  signing.bearer = await new SignJWT({ sub: SUBJECT, org_id: "org_1" })
    .setProtectedHeader({ alg: "ES256", kid: "contract-key" })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(clerk.privateKey)
  signing.runtimeTokenKeys = {
    privatePem: await exportPKCS8(runtime.privateKey),
    publicPem: await exportSPKI(runtime.publicKey),
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Serve the JWKS, and swallow everything else.
 *
 * `createRemoteJWKSet` fetches the key set over the global fetch, and the
 * create route fires lease-tenant and lease-count writes it deliberately does
 * not await. Both must stay inside the process.
 */
function stubFetch() {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === JWKS_URL) return Response.json(signing.jwks)
    return new Response("{}", { headers: { "content-type": "application/json" } })
  }) as unknown as typeof globalThis.fetch
}

/** The authority answers, typed by the port so a port change breaks the build. */
const ENROLLMENT: HostEnrollment = {
  enrollment_id: "enr_1",
  host_id: "host_1",
  display_name: "Yash laptop",
  expires_at: 9_999,
  last_seen_at: 1_000,
  created_at: 500,
}

function provisioningSandboxManager() {
  return {
    list: vi.fn(async () => []),
    ensure: vi.fn(async () => ({
      status: "provisioning" as const,
      workspaceId: WORKSPACE_ID,
      epoch: 1,
      retryAfterMs: 2_000,
      bootMode: "cold-start" as const,
      homeRegion: "us-east",
    })),
  } as unknown as SandboxManager
}

function fakeSandboxManager() {
  const lease = {
    workspaceId: WORKSPACE_ID,
    status: "ready" as const,
    sandboxId: "sandbox_1",
    url: "https://runtime.test/ws_1",
    hostId: "host_cloud_1",
    epoch: 1,
    homeRegion: "us-east",
    persistence: { resume: "same-sandbox", capture: "filesystem", clone: false },
    labels: { image: "runtime:1", runtimeVersion: "0.7.0" },
  }
  return {
    list: vi.fn(async () => [lease]),
    ensure: vi.fn(async () => lease),
    checkpoint: vi.fn(async () => ({ ok: true, lease: { ...lease, status: "stopped" } })),
    restore: vi.fn(async () => ({ ok: true, lease })),
    stop: vi.fn(async () => ({ ok: true, status: "stopped" })),
    destroy: vi.fn(async () => ({ ok: true })),
    release: vi.fn(async () => ({ released: true })),
  } as unknown as SandboxManager
}

/**
 * One hosted plane wired for every operation at once.
 *
 * Deliberately one plane rather than sixteen: a per-case plane is a per-case
 * opportunity to shape the world until the assertion passes, which is the
 * fixture problem again wearing a different hat.
 */
function contractPlane(sandboxManager: SandboxManager = fakeSandboxManager()): HostedControlPlane {
  const services = {
    // No injected verifier on purpose — see `signing`.
    auth: { config: { enabled: true, issuer: ISSUER, jwksUrl: JWKS_URL } },
    relay: {
      relayUrl: "https://relay.test",
      resolverToken: "resolver-token",
      runtimeAccessTokenSigner: vi.fn(async () => ({
        runtimeAccessToken: "rat-token",
        tokenExpiresAt: 1_000_000,
        jti: "jti_1",
      })),
      hostTunnelTokenSigner: vi.fn(),
    },
    sandbox: { sandboxManager },
    authority: {
      usersMe: vi.fn(async () => ({ id: "user_1", user_id: "user_1", subject: "user_1" })),
      resolveOrgId: vi.fn(async () => "org_1"),
      auditAllow: vi.fn(async () => ({})),
      auditDeny: vi.fn(async () => ({})),
      // One of each access kind. A single-kind authority cannot tell an
      // operation that filters from one that returns everything, which is the
      // difference the two list operations exist to make.
      listWorkspaces: vi.fn(async () => [
        { workspace_id: WORKSPACE_ID, access: "cloud", display_name: "Widgets", remote_directory: "/workspace" },
        {
          workspace_id: USER_HOSTED_WORKSPACE_ID,
          access: "user-hosted",
          display_name: "Laptop",
          remote_directory: "/home/dev/widgets",
        },
      ]),
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: WORKSPACE_ID, access: "cloud", backing: "cloud-vm", home_region: "us-east" },
      })),
      authorizeWorkspaceOpen: vi.fn(async () => ({ allowed: true, role: "owner" })),
      createCloudWorkspace: vi.fn(async () => ({ workspace_id: WORKSPACE_ID })),
      recordRuntimeAccessToken: vi.fn(async () => ({})),
      runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
      createHostEnrollmentRequest: vi.fn(async () => ({
        request_id: "req_1",
        nonce: "nonce_1",
        expires_at: 9_999,
      })),
      enrollHost: vi.fn(async () => ENROLLMENT),
      heartbeatHostEnrollment: vi.fn(async () => ({ expires_at: 9_999, last_seen_at: 1_000 })),
    },
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  } as unknown as ControlPlaneServices

  return {
    services,
    relayUrl: "https://relay.test",
    resolverToken: "resolver-token",
    safetyLimits: {
      connectionRateLimit: 1_000,
      connectionRateLimitWindowMs: 60_000,
      controlPlaneRateLimit: 1_000,
      controlPlaneRateLimitWindowMs: 60_000,
      defaultRequestRateLimit: 10_000,
      defaultRequestRateLimitWindowMs: 60_000,
      sandboxMaxRetryCount: 5,
    },
    relayTargetLookup: sandboxRelayTargetLookup({
      sandboxManager: services.sandbox.sandboxManager!,
      telemetry: services.telemetry,
    }),
    cliSessionTokenRegistry: durableCliSessionTokenRegistry().registry,
    env: {
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
      CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
      // `account.cliExchange` mints a real CLI session token; without a signing
      // key the route answers 503 and the operation could never be bound.
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: signing.runtimeTokenKeys.privatePem,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: signing.runtimeTokenKeys.publicPem,
      CLAXEDO_CLI_ACCESS_TOKEN_TTL_SECONDS: "600",
    },
  } as unknown as HostedControlPlane
}

/**
 * The parameters each operation needs, and nothing else.
 *
 * These are the caller's PARAMETERS, not a request: `resolveHostedOperation`
 * turns them into the method, path, and body the desktop table declares, so an
 * operation whose declared body the route rejects fails here on status long
 * before its decoder is reached. Three did.
 */
const OPERATION_INPUT: Record<HostedOperationName, Record<string, unknown>> = {
  "account.get": {},
  "account.mode": {},
  "account.compatibility": {},
  "account.cliExchange": { code: "device_code_1" },
  // No parameters: the access kind each of these lists is fixed in its path.
  "workspace.list.cloud": {},
  "workspace.list.userHosted": {},
  "workspace.resolve": {},
  "workspace.create": {
    projectId: "proj_1",
    projectName: "Widgets",
    workspaceName: "main",
    repoUrl: "https://github.com/acme/widgets.git",
  },
  // `replace` rather than `stop`: the operation that needs the approval field,
  // so the declared body has to carry it.
  "workspace.lifecycle": { id: WORKSPACE_ID, operation: "replace", approved: true, checkpointId: CHECKPOINT_ID },
  "workspace.checkpoints.list": { id: WORKSPACE_ID },
  "workspace.checkpoints.restore": { id: WORKSPACE_ID, checkpointId: CHECKPOINT_ID, approved: true },
  "workspace.connection.mint": { id: WORKSPACE_ID },
  "workspace.connection.refresh": { id: WORKSPACE_ID },
  "host.enrollCurrentMachine": {
    hostId: "host_1",
    publicKey: "-----BEGIN PUBLIC KEY-----",
    requestId: "req_1",
    signature: "sig",
    displayName: "Yash laptop",
  },
  "host.enrollmentNonce": { hostId: "host_1" },
  "host.enrollmentHeartbeat": { hostId: "host_1", signature: "sig", ttlMs: 60_000 },
}

/**
 * Send exactly what the desktop table resolves, and nothing more.
 *
 * No per-operation body patching. A test that quietly adds the field a route
 * demands is a test that makes an operation look reachable when main could
 * never send it — which is how `workspace.checkpoints.restore` and
 * `workspace.lifecycle` sat declaring no body against routes that answer 409
 * without one.
 */
async function callRequest(
  request: { method: string; path: string; body?: Record<string, unknown> },
  sandboxManager?: SandboxManager,
) {
  stubFetch()
  const plane = contractPlane(sandboxManager)
  const app = createHostedApp(plane, { entitlementGate: async () => undefined })
  const response = await app.fetch(
    new Request(`http://cp.test${request.path}`, {
      method: request.method,
      headers: { authorization: `Bearer ${signing.bearer}`, "content-type": "application/json" },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    }),
  )
  const text = await response.text()
  return { response, text, parsed: text === "" ? undefined : (JSON.parse(text) as unknown) }
}

async function callOperation(name: HostedOperationName, sandboxManager?: SandboxManager) {
  return await callRequest(resolveHostedOperation(name, OPERATION_INPUT[name]), sandboxManager)
}

/** The `workspaces` envelope this route answers, as rows. */
function listedWorkspaces(parsed: unknown) {
  const rows = (parsed as { workspaces?: unknown[] } | undefined)?.workspaces
  return (Array.isArray(rows) ? rows : []) as Record<string, unknown>[]
}

describe("hosted operation response contract", () => {
  test("binds every named operation, with no exemptions", () => {
    // The closed set, held equal across all three sides at once. An operation
    // added to any one of them without the other two fails here, and an
    // operation quietly dropped from this file's coverage fails here too —
    // there is no exemption list to add a name to.
    expect(Object.keys(OPERATION_INPUT).toSorted()).toEqual(Object.keys(OPERATION_ROUTES).toSorted())
    expect(Object.keys(OPERATION_DECODERS).toSorted()).toEqual(Object.keys(OPERATION_ROUTES).toSorted())
  })

  test("exercises every field each operation declares", () => {
    // Without this, a declared field the route would reject stays invisible:
    // `resolveHostedOperation` drops a parameter the caller did not pass, so an
    // input that happens to omit it produces a request the route accepts and
    // the whole call looks fine. `workspace.create` declared `displayName`
    // against a strict schema for exactly that reason. Every declared field
    // must therefore reach a real route below.
    const missing = (Object.keys(OPERATION_ROUTES) as HostedOperationName[]).flatMap((name) => {
      const declared = (OPERATION_ROUTES[name] as { body?: readonly string[] }).body ?? []
      return declared
        .filter((field) => OPERATION_INPUT[name][field] === undefined)
        .map((field) => `${name}.${field}`)
    })

    expect(missing).toEqual([])
  })

  test("every query a path declares changes what the route answers", async () => {
    // The counterpart to the check above, for the other kind of declared thing,
    // and it has to ask a different question. A declared body field can fail to
    // REACH the route; a query written into the path always reaches it. What a
    // query can do instead is nothing at all — and an ignored query is
    // invisible, because the answer still decodes.
    //
    // The workspace list shipped the mirror image of that: no query where the
    // route required one, so it answered `{ workspaces: [] }` for its whole
    // life and every decoder was happy. So each declared query must be
    // load-bearing — strip it, and the route must answer something else.
    const withQuery = (Object.keys(OPERATION_ROUTES) as HostedOperationName[]).filter((name) =>
      OPERATION_ROUTES[name].path.includes("?"),
    )

    expect(withQuery.length, "no operation declares a query, so this check holds nothing").toBeGreaterThan(0)

    for (const name of withQuery) {
      const declared = resolveHostedOperation(name, OPERATION_INPUT[name])
      const answered = await callRequest(declared)
      const stripped = await callRequest({ ...declared, path: declared.path.split("?")[0]! })

      expect(answered.response.status, `${name} -> ${answered.text.slice(0, 400)}`).toBe(200)
      expect(stripped.text, `${name}: the declared query changes nothing about the answer`).not.toBe(answered.text)
    }
  })

  for (const name of Object.keys(OPERATION_ROUTES) as HostedOperationName[]) {
    test(`${name} answers a body its decoder accepts`, async () => {
      const { response, text, parsed } = await callOperation(name)
      expect(response.status, `${name} -> ${text.slice(0, 400)}`).toBe(200)
      expect(() => decodeHostedResult(name, parsed)).not.toThrow()
    })
  }

  test("the workspace list answers ROWS, one operation per access kind", async () => {
    // The assertion the empty list survived. "Decodes without throwing" is
    // satisfied by `{ workspaces: [] }`, which is what `GET /api/workspace`
    // answers to any caller that does not name an access kind — so the old
    // single access-less operation passed the case above while never once
    // returning a workspace. Only a non-empty list can tell the two apart.
    const cloud = await callOperation("workspace.list.cloud")
    expect(cloud.response.status, cloud.text.slice(0, 400)).toBe(200)
    expect(listedWorkspaces(cloud.parsed).length).toBeGreaterThan(0)
    expect(listedWorkspaces(cloud.parsed).map((row) => row["workspace_id"])).toContain(WORKSPACE_ID)

    // And the other kind is a different answer, not the same one twice: this
    // route filters to user-hosted rows for this access kind, which is the only
    // reason two operations are worth having.
    const userHosted = await callOperation("workspace.list.userHosted")
    expect(userHosted.response.status, userHosted.text.slice(0, 400)).toBe(200)
    expect(listedWorkspaces(userHosted.parsed).length).toBeGreaterThan(0)
    expect(listedWorkspaces(userHosted.parsed).map((row) => row["workspace_id"])).toEqual([USER_HOSTED_WORKSPACE_ID])
  })

  for (const name of ["workspace.connection.mint", "workspace.connection.refresh"] as const) {
    test(`${name} accepts the cold start, not just the settled connection`, async () => {
      // The route answers 200 twice with different bodies: `provisioning` while
      // the sandbox comes up, then the mint. A ready-only fake never produces
      // the first, so a decoder that rejected every cold start would still pass
      // the case above — it did.
      const { response, text, parsed } = await callOperation(name, provisioningSandboxManager())

      expect(response.status, `${name} -> ${text.slice(0, 400)}`).toBe(200)
      expect(parsed).toMatchObject({ status: "provisioning" })
      expect(() => decodeHostedResult(name, parsed)).not.toThrow()
    })
  }

  test("a decoder that stops matching its route fails", async () => {
    // Mutation check on the binding itself. Every assertion above is a
    // NEGATIVE — "does not throw" — and a decoder set that accepted anything
    // would satisfy all sixteen. So take a real route body and hand it to a
    // different operation's decoder: if the bodies were not really reaching the
    // decoders, this would pass too.
    const { parsed } = await callOperation("workspace.list.cloud")
    expect(() => decodeHostedResult("workspace.checkpoints.list", parsed)).not.toThrow()
    expect(() => decodeHostedResult("workspace.connection.mint", parsed)).toThrow(/relayUrl/)
    expect(() => decodeHostedResult("host.enrollCurrentMachine", parsed)).toThrow(/enrollment/)
  })
})
