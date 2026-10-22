import { afterEach, describe, expect, test } from "vitest"
import { enrollmentPayload } from "@claxedo/account-contract/machine"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { MachinePrincipal } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { d1Authority } from "../../../test-support/d1-authority"

type Harness = Awaited<ReturnType<typeof d1Authority>>
const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function servingMachine(harness: Harness, owner: SignedControlPlaneAuth, hostId: string, workspaceId: string) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const request = await harness.authority.createHostEnrollmentRequest(owner, { hostId })
  const payload = new TextEncoder().encode(enrollmentPayload({ hostId, requestId: request.request_id, nonce: request.nonce }))
  const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, payload)).toString("base64url")
  const enrollment = await harness.authority.enrollHost(owner, {
    hostId,
    publicKey: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    requestId: request.request_id,
    signature,
    ttlMs: 60_000,
  })
  await harness.authority.assignWorkspaceHost(owner, { workspaceId, hostId, remoteDirectory: `/srv/${workspaceId}` })
  const row = await harness.authority.machineAuth?.lookupEnrollment(enrollment.enrollment_id)
  if (!row) throw new Error("no enrollment")
  const machine: MachinePrincipal = {
    enrollmentId: row.enrollment_id,
    hostId: row.host_id,
    ownerUserId: row.owner_user_id,
    ownerActorId: row.owner_actor_id,
    scope: row.scope,
    keyVersion: row.key_version,
    generation: row.serving_generation,
  }
  await harness.authority.heartbeatHostEnrollmentByMachine?.(machine, {
    enrollmentId: machine.enrollmentId,
    hostId,
    generation: machine.generation,
    acks: [{ workspaceId, revision: 1 }],
    ttlMs: 60_000,
  })
  return machine
}

describe("an enrollment's direct routes in D1", () => {
  test("are the last reported routes of the enrollment serving the workspace, gone once it reports none or stops serving", async () => {
    const harness = await d1Authority()
    disposals.push(harness.dispose)
    const owner = await harness.signIn("owner")
    await harness.authority.createHostedOrganization(owner, { name: "Acme", orgId: "org_acme" })
    await harness.authority.createWorkspace(owner, { workspaceId: "ws_local", orgId: "org_acme", displayName: "local", repoUrl: "https://github.com/acme/local.git", backing: "local-worktree" })
    const machine = await servingMachine(harness, owner, "host-laptop", "ws_local")
    const first = { port: 44_321, addresses: ["192.168.1.20"], spkiSha256: "A".repeat(43) }
    const moved = { port: 44_321, addresses: ["100.101.102.103", "192.168.1.31"], spkiSha256: "A".repeat(43) }

    expect(await harness.authority.hostDirectRoutes?.({ workspaceId: "ws_local" })).toBeUndefined()
    await harness.authority.recordHostDirectRoutes?.(machine, first)
    expect(await harness.authority.hostDirectRoutes?.({ workspaceId: "ws_local" })).toEqual(first)
    await harness.authority.recordHostDirectRoutes?.(machine, moved)
    expect(await harness.authority.hostDirectRoutes?.({ workspaceId: "ws_local" })).toEqual(moved)
    expect((await harness.database.prepare("select count(*) as rows from host_direct_routes").first<{ rows: number }>())?.rows).toBe(1)

    await harness.authority.recordHostDirectRoutes?.(machine, undefined)
    expect(await harness.authority.hostDirectRoutes?.({ workspaceId: "ws_local" })).toBeUndefined()

    await harness.authority.recordHostDirectRoutes?.(machine, first)
    await harness.authority.unassignWorkspaceHost(owner, { workspaceId: "ws_local" })
    expect(await harness.authority.hostDirectRoutes?.({ workspaceId: "ws_local" })).toBeUndefined()
  })
})
