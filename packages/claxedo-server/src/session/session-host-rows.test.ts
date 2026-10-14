import { describe, expect, test } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import type { HostSessionRow } from "@claxedo/server-core/platform/auth/host-session-rows"
import type { SessionHostPlacement } from "../authority/session-hosts"
import { turnLeaseMinter, type TurnLeaseClaims } from "./runtime-session-proofs"
import { createSessionHostRows } from "./session-host-rows"

const SESSION = "ses_hosted"
const WORKSPACE = "ws_cloud"
const OWNER = { userId: "user_owner", actorId: "actor_owner", orgId: "org_1", projectId: "prj_1" }

const row: HostSessionRow = {
  workspaceId: WORKSPACE, sessionId: SESSION, createdAt: 1, updatedAt: 2, lastHumanTurnAt: 2,
  status: { kind: "idle", awaitingInput: false, at: 3 }, lastTurn: { status: "completed", completedAt: 3 },
}

async function plane(input: { placement?: SessionHostPlacement | undefined; owner?: typeof OWNER | undefined } = {}) {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const env = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
  const placement: SessionHostPlacement | undefined = "placement" in input ? input.placement : {
    workspace: { backing: "cloud-vm", directory: "/workspace" },
    session: { workspaceId: WORKSPACE, sessionHostRoot: SESSION, deleted: false, creatorUserId: OWNER.userId },
  }
  const rows = createSessionHostRows({
    env,
    sessionHosts: { readSessionHostPlacement: async () => placement },
    resolveWorkspaceOwner: async () => ("owner" in input ? input.owner : OWNER),
  })
  const lease = async (claims: Partial<TurnLeaseClaims> = {}) => (await turnLeaseMinter(env)({
    principalKind: "user", actorId: OWNER.actorId, actorKind: "human", transport: "relay-host",
    hostId: sessionHostId(SESSION), parentRuntimeAccessTokenJti: "rat_1", orgId: OWNER.orgId, workspaceId: WORKSPACE,
    sessionId: SESSION, action: "write", turnId: "msg_1", authorityLeaseId: "turn_1", fencingToken: 1,
    acquiredAt: Date.now(), expiresAt: Date.now() + 60_000, ...claims,
  } as TurnLeaseClaims)).lease
  return { rows, lease }
}

describe("a session host's turn lease at the rows door", () => {
  test("admits the session's own host for its one row, as the workspace owner's publisher", async () => {
    const { rows, lease } = await plane()
    const token = await lease()
    expect(rows.names(token)).toBe(true)
    await expect(rows.admit(token, sessionHostId(SESSION), { rows: [row], removed: [] })).resolves.toEqual({
      hostId: sessionHostId(SESSION), ownerUserId: OWNER.userId, workspaceIds: [WORKSPACE], servedBy: "session-host", sessionId: SESSION,
    })
  })

  test("refuses a publication naming another session, or removing one", async () => {
    const { rows, lease } = await plane()
    const token = await lease()
    await expect(rows.admit(token, sessionHostId(SESSION), { rows: [{ ...row, sessionId: "ses_other" }], removed: [] })).resolves.toBeUndefined()
    await expect(rows.admit(token, sessionHostId(SESSION), { rows: [], removed: [{ workspaceId: WORKSPACE, sessionId: SESSION }] })).resolves.toBeUndefined()
  })

  test("refuses a lease minted for a sandbox runtime, another host id, or a session placed elsewhere", async () => {
    const { rows, lease } = await plane()
    await expect(rows.admit(await lease({ hostId: "host_sandbox" }), "host_sandbox", { rows: [row], removed: [] })).resolves.toBeUndefined()
    await expect(rows.admit(await lease(), "machine-r", { rows: [row], removed: [] })).resolves.toBeUndefined()
    const moved = await plane({ placement: { workspace: { backing: "cloud-vm", directory: "/workspace" }, session: { workspaceId: WORKSPACE, sessionHostRoot: null, deleted: false, creatorUserId: OWNER.userId } } })
    await expect(moved.rows.admit(await moved.lease(), sessionHostId(SESSION), { rows: [row], removed: [] })).resolves.toBeUndefined()
    const deleted = await plane({ placement: { workspace: { backing: "cloud-vm", directory: "/workspace" }, session: { workspaceId: WORKSPACE, sessionHostRoot: SESSION, deleted: true, creatorUserId: OWNER.userId } } })
    await expect(deleted.rows.admit(await deleted.lease(), sessionHostId(SESSION), { rows: [row], removed: [] })).resolves.toBeUndefined()
  })

  test("refuses a workspace whose owner left the lease's organization, and a bearer that is no lease", async () => {
    const reowned = await plane({ owner: { ...OWNER, orgId: "org_2" } })
    await expect(reowned.rows.admit(await reowned.lease(), sessionHostId(SESSION), { rows: [row], removed: [] })).resolves.toBeUndefined()
    const { rows } = await plane()
    expect(rows.names("not-a-jwt")).toBe(false)
    await expect(rows.admit("not-a-jwt", sessionHostId(SESSION), { rows: [row], removed: [] })).resolves.toBeUndefined()
  })
})
