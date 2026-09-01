import { createPrivateKey, generateKeyPairSync, sign as signData } from "node:crypto"
import { convexTest } from "convex-test"
import { getFunctionName } from "convex/server"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createConvexAuthority } from "./index"
import schema from "../../../../../../../convex/schema"

/**
 * WHICH Convex function each enrollment method calls.
 *
 * Not a style question. `convex/hostEnrollments.ts` exposes every verb twice —
 * an `authedMutation`/`authedQuery` that makes Convex resolve the identity from
 * the bearer it was handed, and a `*ForService` variant that takes this
 * server's shared service token plus an identity this server asserts. Choosing
 * the wrong one is an authorization defect in one direction and an outage in
 * the other:
 *
 *  - Service-for-everything discards Convex's own verification of the end
 *    user's credential, so a leaked service token becomes enough to enroll a
 *    machine as any account.
 *  - Authed-for-everything rejects every CLI session token, because that token
 *    is signed by this control plane rather than by the identity provider and
 *    `ctx.auth.getUserIdentity()` sees nothing. That is the entire Host
 *    Connector population — the callers this feature exists for.
 *
 * The parity suite (`routes/hosted/host-enrollment.parity.test.ts`) drives the
 * Clerk-bearer half end to end. This file pins the branch itself, and takes the
 * service half through the real Convex functions.
 */

const clerkAuth: SignedControlPlaneAuth = {
  mode: "signed",
  token: "clerk_bearer",
  user: {
    subject: "user_1",
    tokenIdentifier: "https://clerk.example.test|user_1",
    issuer: "https://clerk.example.test",
  },
}

const cliAuth: SignedControlPlaneAuth = {
  ...clerkAuth,
  token: "claxedo_cli_token",
  tokenKind: "cli",
}

/** See the alias in `routes/hosted/host-enrollment.parity.test.ts` — same reason. */
type ConvexTestCall = (fn: unknown, args: unknown) => Promise<unknown>

const modules = import.meta.glob("../../../../../../../convex/**/*.ts")

const previousServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN

afterEach(() => {
  if (previousServiceToken === undefined) {
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    return
  }
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previousServiceToken
})

/** Records the Convex function NAME each call targeted, plus its args. */
function recorder() {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const record = vi.fn(async (fn: unknown, args: Record<string, unknown>) => {
    calls.push({ fn: getFunctionName(fn as never), args })
    return { paused: true }
  })
  return {
    calls,
    authority: createConvexAuthority({
      executor: { query: record, mutation: record },
      serviceToken: "svc_secret",
    }),
  }
}

async function driveEveryMethod(authority: ReturnType<typeof recorder>["authority"], auth: SignedControlPlaneAuth) {
  await authority.createHostEnrollmentRequest!(auth, { hostId: "host_1" })
  await authority.enrollHost!(auth, { hostId: "host_1", publicKey: "{}", requestId: "req_1", signature: "sig" })
  await authority.heartbeatHostEnrollment!(auth, { hostId: "host_1", signature: "sig", workspaceIds: ["ws_1"] })
  await authority.pauseHostEnrollment!(auth, { hostId: "host_1", paused: true })
  await authority.activeHostEnrollment!(auth)
  await authority.assignWorkspaceHost!(auth, { workspaceId: "ws_1", hostId: "host_1" })
  await authority.unassignWorkspaceHost!(auth, { workspaceId: "ws_1" })
}

describe("enrollment routes a Clerk bearer to the authed Convex functions", () => {
  test("every method uses the identity-verifying variant", async () => {
    const { calls, authority } = recorder()

    await driveEveryMethod(authority, clerkAuth)

    expect(calls.map((call) => call.fn)).toEqual([
      "hostEnrollments:createRequest",
      "hostEnrollments:enroll",
      "hostEnrollments:heartbeat",
      "hostEnrollments:pause",
      "hostEnrollments:active",
      "hostEnrollments:assignWorkspace",
      "hostEnrollments:unassignWorkspace",
    ])
  })

  test("and never sends the service token, which would let it act as anyone", async () => {
    const { calls, authority } = recorder()

    await driveEveryMethod(authority, clerkAuth)

    expect(calls.flatMap((call) => Object.keys(call.args))).not.toContain("service_token")
    expect(calls.flatMap((call) => Object.keys(call.args))).not.toContain("user")
  })

  test("the heartbeat body carries the served set the v2 signature covers", async () => {
    const { calls, authority } = recorder()

    await authority.heartbeatHostEnrollment!(clerkAuth, {
      hostId: "host_1",
      signature: "sig",
      workspaceIds: ["ws_b", "ws_a"],
    })

    expect(calls[0]!.args.workspace_ids).toEqual(["ws_b", "ws_a"])
  })

  test("assignment reads use the caller's own bearer", async () => {
    const { calls, authority } = recorder()

    await authority.activeWorkspaceHost!(clerkAuth, { workspaceId: "ws_1" })
    await authority.listHostAssignments!(clerkAuth)

    expect(calls.map((call) => call.fn)).toEqual([
      "hostEnrollments:activeWorkspaceHost",
      "hostEnrollments:listAssignments",
    ])
    expect(calls.flatMap((call) => Object.keys(call.args))).not.toContain("service_token")
  })
})

describe("enrollment routes a CLI session token to the service Convex functions", () => {
  test("every method uses the service variant, because Convex cannot verify a CLI token", async () => {
    const { calls, authority } = recorder()

    await driveEveryMethod(authority, cliAuth)

    expect(calls.map((call) => call.fn)).toEqual([
      "hostEnrollments:createRequestForService",
      "hostEnrollments:enrollForService",
      "hostEnrollments:heartbeatForService",
      "hostEnrollments:pauseForService",
      "hostEnrollments:activeForService",
      "hostEnrollments:assignWorkspaceForService",
      "hostEnrollments:unassignWorkspaceForService",
    ])
  })

  test("carrying the service token and the identity this server already verified", async () => {
    const { calls, authority } = recorder()

    await driveEveryMethod(authority, cliAuth)

    for (const call of calls) {
      expect(call.args.service_token, call.fn).toBe("svc_secret")
      expect(call.args.user, call.fn).toEqual({
        token_identifier: clerkAuth.user.tokenIdentifier,
        subject: clerkAuth.user.subject,
        issuer: clerkAuth.user.issuer,
      })
    }
  })
})

/**
 * The service path against the real functions.
 *
 * A name assertion proves the branch; this proves the branch WORKS — that
 * `upsertServiceUser` lands on the same user row `upsertUser` would have, so a
 * machine enrolled by a CLI caller is the machine the same account sees through
 * its browser session. Getting that wrong produces two enrollments for one
 * person and no error anywhere.
 */
describe("a CLI caller and a Clerk caller are the same account", () => {
  test("a machine enrolled through the service path is visible through the authed one", async () => {
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
    const t = convexTest(schema, modules)
    const service = createConvexAuthority({
      executor: {
        query: (fn, args) => (t.query as ConvexTestCall)(fn, args),
        mutation: (fn, args) => (t.mutation as ConvexTestCall)(fn, args),
      },
      serviceToken: "svc_secret",
    })
    const as = t.withIdentity({
      tokenIdentifier: clerkAuth.user.tokenIdentifier,
      subject: clerkAuth.user.subject,
    })
    const browser = createConvexAuthority({
      executor: {
        query: (fn, args) => (as.query as ConvexTestCall)(fn, args),
        mutation: (fn, args) => (as.mutation as ConvexTestCall)(fn, args),
      },
    })

    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
    const jwk = pair.privateKey.export({ format: "jwk" })
    const request = await service.createHostEnrollmentRequest!(cliAuth, { hostId: "host_cli" })
    const payload = [
      "claxedo.host-enrollment.enroll.v1",
      "host_id=host_cli",
      `request_id=${request.request_id}`,
      `nonce=${request.nonce}`,
    ].join("\n")
    await service.enrollHost!(cliAuth, {
      hostId: "host_cli",
      publicKey: JSON.stringify(pair.publicKey.export({ format: "jwk" })),
      requestId: request.request_id,
      signature: signData("sha256", Buffer.from(payload), {
        key: createPrivateKey({ key: jwk, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      }).toString("base64url"),
      displayName: "Work laptop",
    })

    await expect(browser.activeHostEnrollment!(clerkAuth)).resolves.toMatchObject({
      active: true,
      host_id: "host_cli",
      display_name: "Work laptop",
    })

    // The assignment grain, end to end through the adapter: the owner assigns
    // the workspace to the machine, the machine acks it with the ONE v2
    // heartbeat signature over the exact payload literal, and only then is the
    // workspace routable — with the acked set stored on the enrollment.
    await expect(service.assignWorkspaceHost!(cliAuth, { workspaceId: "ws_adapter", hostId: "host_cli" }))
      .resolves.toEqual({ assigned: true, workspace_id: "ws_adapter", host_id: "host_cli" })
    await expect(browser.activeWorkspaceHost!(clerkAuth, { workspaceId: "ws_adapter" }))
      .resolves.toEqual({ active: false })

    const heartbeatPayload = [
      "claxedo.host-enrollment.heartbeat.v2",
      "host_id=host_cli",
      "ttl_ms=",
      "workspaces=ws_adapter",
    ].join("\n")
    const beat = await service.heartbeatHostEnrollment!(cliAuth, {
      hostId: "host_cli",
      workspaceIds: ["ws_adapter"],
      signature: signData("sha256", Buffer.from(heartbeatPayload), {
        key: createPrivateKey({ key: jwk, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      }).toString("base64url"),
    })
    expect(beat.assigned_workspace_ids).toEqual(["ws_adapter"])

    await expect(browser.activeWorkspaceHost!(clerkAuth, { workspaceId: "ws_adapter" })).resolves.toMatchObject({
      active: true,
      host_id: "host_cli",
      workspace_id: "ws_adapter",
    })
    await expect(browser.listHostAssignments!(clerkAuth)).resolves.toMatchObject([
      { host_id: "host_cli", workspace_ids: ["ws_adapter"], acked_workspace_ids: ["ws_adapter"] },
    ])
  })
})

/**
 * `POST /pause` returns the authority's result verbatim, and Convex's `pause`
 * also reports how many rows it touched — a field the SQLite authority has no
 * equivalent of and the port does not declare. The adapter narrows it away, so
 * the two backends cannot hand clients different objects.
 */
describe("pause returns the port's shape, not Convex's", () => {
  test("the row count Convex reports does not reach the caller", async () => {
    const authority = createConvexAuthority({
      executor: {
        query: vi.fn(),
        mutation: vi.fn(async () => ({ paused: true, count: 3 })),
      },
    })

    await expect(authority.pauseHostEnrollment!(clerkAuth, { paused: true })).resolves.toEqual({ paused: true })
  })
})
