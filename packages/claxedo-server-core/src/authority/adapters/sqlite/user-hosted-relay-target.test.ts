import { generateKeyPairSync, sign as signData, type KeyObject } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createSqliteUserHostedTargetResolver } from "./user-hosted-relay-target"
import { createSqliteWorkspaceAuthority } from "./workspace-authority"
import { closeAuthorityDatabases } from "./workspace-authority-store"

/**
 * The relay resolver's answer must be the readiness predicate and nothing
 * else: what `activeWorkspaceHost` says for the owner, the service-side
 * lookup says with no principal. Every state is reached through the
 * authority's own methods, so a drift between the two readers fails here.
 */

const owner: SignedControlPlaneAuth = {
  mode: "signed",
  token: "tok_owner",
  user: { subject: "user_owner", tokenIdentifier: "https://idp.example.test|user_owner", issuer: "https://idp.example.test" },
}
const roots: string[] = []

afterEach(() => {
  closeAuthorityDatabases()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function signPayload(privateKey: KeyObject, payload: string) {
  return signData("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")
}

async function setup(now?: () => number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-relay-target-"))
  roots.push(root)
  const file = path.join(root, "authority.db")
  const api = createSqliteWorkspaceAuthority({ path: file })
  const resolve = createSqliteUserHostedTargetResolver({ path: file, ...(now ? { now } : {}) })
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const hostId = "host_box"
  const request = await api.createHostEnrollmentRequest(owner, { hostId })
  const enrollment = await api.enrollHost(owner, {
    hostId,
    publicKey: JSON.stringify(pair.publicKey.export({ format: "jwk" })),
    requestId: request.request_id,
    signature: signPayload(pair.privateKey, [
      "claxedo.host-enrollment.enroll.v1",
      `host_id=${hostId}`,
      `request_id=${request.request_id}`,
      `nonce=${request.nonce}`,
    ].join("\n")),
  })
  // A machine acks a description at its revision, so the ack set is built from
  // what the owner currently declares. The principal comes straight from the
  // enrollment row: the machine-request verifier has its own coverage, and the
  // subject here is the resolver.
  const beat = async (workspaceIds: string[]) => {
    const row = await api.machineAuth!.lookupEnrollment(enrollment.enrollment_id)
    if (!row) throw new Error("the enrollment this test just made is not in the store")
    const declared = new Map(
      ((await api.listHostEnrollments!(owner))[0]?.assignments ?? []).map((assignment) => [assignment.workspace_id, assignment.revision]),
    )
    return api.heartbeatHostEnrollmentByMachine!({
      enrollmentId: row.enrollment_id,
      hostId: row.host_id,
      ownerUserId: row.owner_user_id,
      ownerActorId: row.owner_actor_id,
      scope: row.scope,
      keyVersion: row.key_version,
      generation: row.serving_generation,
    }, {
      enrollmentId: row.enrollment_id,
      hostId: row.host_id,
      generation: row.serving_generation,
      acks: workspaceIds.map((workspaceId) => {
        const revision = declared.get(workspaceId)
        if (revision === undefined) throw new Error(`no assignment describes ${workspaceId}`)
        return { workspaceId, revision }
      }),
    })
  }
  return { api, resolve, hostId, beat }
}

describe("SQLite user-hosted relay target", () => {
  test("answers the readiness predicate: assigned and acked routes, assigned-only does not", async () => {
    const { api, resolve, hostId, beat } = await setup()
    await expect(resolve("ws_api")).resolves.toEqual({ active: false })

    await api.assignWorkspaceHost(owner, { workspaceId: "ws_api", hostId, remoteDirectory: "/srv/api" })
    await expect(resolve("ws_api")).resolves.toEqual({ active: false })
    await expect(api.activeWorkspaceHost(owner, { workspaceId: "ws_api" })).resolves.toEqual({ active: false })

    await beat(["ws_api"])
    await expect(resolve("ws_api")).resolves.toEqual({ active: true, hostId, backing: "local-worktree" })
    await expect(api.activeWorkspaceHost(owner, { workspaceId: "ws_api" })).resolves.toMatchObject({ active: true, host_id: hostId })
  })

  test("a workspace the host stopped acking, an unassigned one, and a blank id are not targets", async () => {
    const { api, resolve, hostId, beat } = await setup()
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_api", hostId, remoteDirectory: "/srv/api" })
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_web", hostId, remoteDirectory: "/srv/web" })
    await beat(["ws_api", "ws_web"])
    await expect(resolve("ws_web")).resolves.toEqual({ active: true, hostId, backing: "local-worktree" })

    await beat(["ws_api"])
    await expect(resolve("ws_web")).resolves.toEqual({ active: false })
    await expect(resolve("ws_api")).resolves.toEqual({ active: true, hostId, backing: "local-worktree" })

    await api.unassignWorkspaceHost(owner, { workspaceId: "ws_api" })
    await expect(resolve("ws_api")).resolves.toEqual({ active: false })
    await expect(resolve("   ")).resolves.toEqual({ active: false })
  })

  test("a revoked machine and an expired lease stop routing on the next read", async () => {
    let clock = Date.now()
    const { api, resolve, hostId, beat } = await setup(() => clock)
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_api", hostId, remoteDirectory: "/srv/api" })
    await beat(["ws_api"])
    await expect(resolve("ws_api")).resolves.toEqual({ active: true, hostId, backing: "local-worktree" })

    clock += 61_000
    await expect(resolve("ws_api")).resolves.toEqual({ active: false })
    clock -= 61_000
    await expect(resolve("ws_api")).resolves.toEqual({ active: true, hostId, backing: "local-worktree" })

    await api.revokeHostEnrollment(owner, { hostId })
    await expect(resolve("ws_api")).resolves.toEqual({ active: false })
  })
})
