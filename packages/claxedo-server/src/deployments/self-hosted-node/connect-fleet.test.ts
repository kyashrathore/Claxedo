import { generateKeyPairSync, sign as signData, type KeyObject } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { sha256Hex } from "@claxedo/helpers/crypto"
import {
  MACHINE_REQUEST_HEADERS,
  invitationRedeemPayload,
  invitationTokenParts,
  machineRequestPayload,
  publicKeyFingerprint,
} from "@claxedo/server-core/platform/auth/host-connect-contract"

/**
 * A `claxedo connect` fleet on the signed self-hosted node, driven through the
 * routes `claxedo host …`, the machine and the relay child call — the same
 * modules the hosted Worker mounts, over this node's SQLite authority. This
 * node's own machine identity is the one host a body may not name.
 */

let dataDir: string
let previousEnv: Record<string, string | undefined>
let services: Awaited<ReturnType<typeof import("./app").createDefaultLocalControlPlaneServices>>
let composed: ReturnType<typeof import("./app").createSelfHostedApp>

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-connect-fleet-"))
  previousEnv = {
    CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
    CLAXEDO_SIGNED_CLOUD_AUTH: process.env.CLAXEDO_SIGNED_CLOUD_AUTH,
    CLAXEDO_EMBEDDED_AUTH: process.env.CLAXEDO_EMBEDDED_AUTH,
  }
  process.env.CLAXEDO_DATA_DIR = dataDir
  process.env.CLAXEDO_SIGNED_CLOUD_AUTH = "1"
  process.env.CLAXEDO_EMBEDDED_AUTH = "1"
  const { resetEmbeddedAuthForTests } = await import("./embedded-auth")
  resetEmbeddedAuthForTests()
  const { createDefaultLocalControlPlaneServices, createSelfHostedApp } = await import("./app")
  services = createDefaultLocalControlPlaneServices()
  composed = createSelfHostedApp(services)
})

afterAll(async () => {
  await composed.dispose()
  services.close()
  const { closeAuthorityDatabases } = await import(
    "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
  )
  closeAuthorityDatabases()
  const { resetEmbeddedAuthForTests } = await import("./embedded-auth")
  resetEmbeddedAuthForTests()
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function signedBearer(email: string) {
  const res = await composed.app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "Fleet Owner" }),
  })
  expect(res.status).toBe(200)
  return { authorization: `Bearer ${res.headers.get("set-auth-token")}`, "content-type": "application/json" }
}

function sign(privateKey: KeyObject, payload: string) {
  return signData("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")
}

let nonce = 0

/** A machine-signed POST, the way `@claxedo/host-connector`'s transport sends one. */
async function machinePost(pathname: string, privateKey: KeyObject, enrollmentId: string, body: unknown) {
  const bodyText = JSON.stringify(body)
  const ts = Date.now()
  const requestNonce = `nonce${String(++nonce).padStart(12, "0")}`
  const signature = sign(privateKey, machineRequestPayload({
    method: "POST",
    pathname,
    bodySha256Hex: await sha256Hex(bodyText),
    ts,
    nonce: requestNonce,
    enrollmentId,
  }))
  return composed.app.request(pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [MACHINE_REQUEST_HEADERS.enrollmentId]: enrollmentId,
      [MACHINE_REQUEST_HEADERS.ts]: String(ts),
      [MACHINE_REQUEST_HEADERS.nonce]: requestNonce,
      [MACHINE_REQUEST_HEADERS.signature]: signature,
    },
    body: bodyText,
  })
}

async function json<T>(response: Response): Promise<T> {
  const text = await response.text()
  expect(response.status, text).toBeLessThan(300)
  return JSON.parse(text) as T
}

describe("a connect fleet on the signed self-hosted node", () => {
  test("invite → redeem → assign by hostId → machine acks → the relay resolver routes to it → revoke closes it all", async () => {
    const owner = await signedBearer("fleet-owner@selfhost.test")
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
    const publicKey = JSON.stringify(pair.publicKey.export({ format: "jwk" }))
    const hostId = "host_box_1"

    const invitation = await json<{ token: string }>(await composed.app.request("/api/claxedo/host/invitations", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ displayName: "box", scope: { allowed_roots: ["/srv"], visibility: "owner" }, expiresInMs: 60_000 }),
    }))
    const parts = invitationTokenParts(invitation.token)!
    const redeemed = await json<{ enrollment: { enrollment_id: string }; resumed: boolean }>(
      await composed.app.request("/api/claxedo/host/enrollments/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          invitationId: parts.invitationId,
          secret: parts.secret,
          hostId,
          publicKey,
          signature: sign(pair.privateKey, invitationRedeemPayload({
            invitationId: parts.invitationId,
            hostId,
            publicKeySha256: await publicKeyFingerprint(JSON.parse(publicKey)),
          })),
        }),
      }),
    )
    const enrollmentId = redeemed.enrollment.enrollment_id
    expect(enrollmentId).toBeTruthy()
    expect(redeemed.resumed).toBe(false)

    const listed = await json<{ machines: Array<{ enrollment_id: string; host_id: string; enrolled_via: string }> }>(
      await composed.app.request("/api/claxedo/host/enrollments", { headers: owner }),
    )
    expect(listed.machines).toEqual([expect.objectContaining({ enrollment_id: enrollmentId, host_id: hostId, enrolled_via: "invitation" })])

    const assigned = await json<{ assignment: { assigned: true; workspace_id: string; host_id: string } }>(
      await composed.app.request("/api/workspace/ws_box_api/host-assignment", {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ hostId, displayName: "api", repoName: "api", remoteDirectory: "/srv/api" }),
      }),
    )
    expect(assigned.assignment).toEqual({ assigned: true, workspace_id: "ws_box_api", host_id: hostId })

    const outsideRoots = await composed.app.request("/api/workspace/ws_box_etc/host-assignment", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ hostId, remoteDirectory: "/etc" }),
    })
    expect(outsideRoots.status).toBe(400)
    await expect(outsideRoots.json()).resolves.toMatchObject({ error: { code: "host_assignment_outside_scope" } })

    const acquired = await json<{ generation: number }>(
      await machinePost("/api/claxedo/host/enrollments/acquire", pair.privateKey, enrollmentId, { enrollmentId, hostId }),
    )
    const target = () => composed.app.request(`/internal/relay/target?workspaceId=ws_box_api&hostId=${hostId}`)
    expect((await target()).status).toBe(409)

    const beat = await json<{ assignments: Array<{ workspace_id: string; revision: number }> }>(
      await machinePost("/api/claxedo/host/enrollments/heartbeat", pair.privateKey, enrollmentId, {
        enrollmentId,
        hostId,
        generation: acquired.generation,
        acks: [{ workspaceId: "ws_box_api", revision: 1 }],
        sessionAuthority: "managed-private",
      }),
    )
    expect(beat.assignments).toEqual([expect.objectContaining({ workspace_id: "ws_box_api", revision: 1 })])

    await expect(json(await target())).resolves.toEqual({
      workspaceId: "ws_box_api",
      hostId,
      baseUrl: "",
      access: "user-hosted",
      backing: "local-worktree",
    })
    await expect(json(await composed.app.request(`/internal/relay/host-generation?enrollmentId=${enrollmentId}`))).resolves.toEqual({
      enrollmentId,
      generation: acquired.generation,
      revoked: false,
    })
    const catalog = await json<{ workspaces: Array<{ workspace_id: string; host_online?: boolean }> }>(
      await composed.app.request("/api/workspace?access=user-hosted", { headers: owner }),
    )
    expect(catalog.workspaces).toEqual([expect.objectContaining({ workspace_id: "ws_box_api", host_online: true })])

    const revoked = await json<{ revoked: boolean }>(
      await composed.app.request(`/api/claxedo/remote-access/devices/${hostId}`, { method: "DELETE", headers: owner }),
    )
    expect(revoked).toEqual({ revoked: true })
    expect((await target()).status).toBe(409)
    await expect(json(await composed.app.request(`/internal/relay/host-generation?enrollmentId=${enrollmentId}`))).resolves.toMatchObject({
      revoked: true,
    })
    const afterRevoke = await machinePost("/api/claxedo/host/enrollments/heartbeat", pair.privateKey, enrollmentId, {
      enrollmentId,
      hostId,
      generation: acquired.generation,
      acks: [],
    })
    expect(afterRevoke.status).toBe(403)
    await expect(afterRevoke.json()).resolves.toMatchObject({ error: { code: "enrollment_revoked" } })
  })

  test("this node's own host identity cannot be assigned by body", async () => {
    const owner = await signedBearer("fleet-owner-2@selfhost.test")
    const { localHostIdentity } = await import("../../workspace/local-host")
    const own = await localHostIdentity()

    const refused = await composed.app.request("/api/workspace/ws_self/host-assignment", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ hostId: own.hostId, remoteDirectory: "/srv/self" }),
    })
    expect(refused.status).toBe(400)
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "host_assignment_identity_server_owned" } })
  })
})
