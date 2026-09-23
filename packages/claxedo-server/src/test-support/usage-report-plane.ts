/**
 * A control plane a cloud workspace runtime can report usage to, over the real
 * session-authority route: a SQLite workspace authority that records turn
 * producers, and the process's own SQLite usage store as the report's writer.
 * `ws_real` is a cloud workspace; `ws_machine` is one a machine serves.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createSqliteWorkspaceAuthority } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"
import { openAuthorityDb } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { createSqliteUsageLedger } from "@claxedo/server-core/usage/adapters/sqlite-usage-ledger"
import type { UsageReportWriter } from "@claxedo/server-core/usage/usage-report"
import { RuntimeSessionAuthorityRoutes } from "../routes/runtime-session-authority"

export const USAGE_REPORT_URL = "https://plane.test/api/runtime-authority/session-authorize"

type Workspace = "ws_real" | "ws_machine"

function signed(subject: string): SignedControlPlaneAuth {
  return {
    mode: "signed",
    token: `token_${subject}`,
    user: { subject, tokenIdentifier: `https://identity.example.test|${subject}`, issuer: "https://identity.example.test" },
  }
}

export async function usageReportPlane(input: { usageWriter?: boolean | UsageReportWriter } = {}) {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const env = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
    CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey),
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-usage-report-plane-"))
  const databasePath = path.join(directory, "authority.db")
  const store = createSqliteWorkspaceAuthority({ path: databasePath })
  const seed = openAuthorityDb({ path: databasePath })
  const owner = signed("owner")
  const member = signed("member")
  const outsider = signed("outsider")
  const { org_id: orgId } = await store.usersMe(owner) as { org_id: string }
  await store.usersMe(member)
  const { org_id: outsiderOrgId } = await store.usersMe(outsider) as { org_id: string }
  await store.createCloudWorkspace(owner, { workspaceId: "ws_real", displayName: "Main" })
  await store.registerLocalForSharing(owner, { workspaceId: "ws_machine", displayName: "Laptop", remoteDirectory: "/work/laptop" })
  for (const workspaceId of ["ws_real", "ws_machine"]) {
    const project = seed().prepare(`SELECT project_id FROM workspaces WHERE workspace_id = ?`).get(workspaceId) as { project_id: string }
    seed().prepare(`
      INSERT INTO project_memberships (project_id, token_identifier, role, created_at, updated_at) VALUES (?, ?, 'editor', 1, 1)
      ON CONFLICT DO NOTHING
    `).run(project.project_id, member.user.tokenIdentifier)
  }
  seed().prepare(`
    INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at) VALUES (?, ?, 'member', 1, 1)
    ON CONFLICT (org_id, token_identifier) DO NOTHING
  `).run(orgId, member.user.tokenIdentifier)

  const ledger = createSqliteUsageLedger()
  let runtimeAccessTokenActive = true
  const target = new Hono().route("/api/runtime-authority", RuntimeSessionAuthorityRoutes({
    authority: {
      ...store,
      runtimeAccessTokenActive: async () => (runtimeAccessTokenActive
        ? { active: true }
        : { active: false, code: "runtime_access_token_revoked", reason: "Runtime Access Token was revoked" }),
    },
    turnAuthority: store,
    env,
    ...(input.usageWriter === false ? {} : { usageWriter: typeof input.usageWriter === "object" ? input.usageWriter : ledger.reports }),
  }))

  const relayToken = (who: SignedControlPlaneAuth, workspaceId: Workspace = "ws_real") => mintRelayHostToken({
    principalKind: "user",
    actorId: who.user.tokenIdentifier,
    actorKind: "human",
    orgId,
    workspaceId,
    hostId: workspaceId === "ws_real" ? "host_sandbox" : "host_laptop",
    role: "editor",
    backing: workspaceId === "ws_real" ? "cloud-vm" : "local-worktree",
    jti: `rht_${who.user.subject}`,
    parentJti: "rat_sandbox",
  }, key.privateKey, "EdDSA")

  const post = (body: Record<string, unknown>, bearer?: string) => target.request(USAGE_REPORT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  })

  /** A session the owner created and shared with the member for sending. */
  async function session(sessionId: string, workspaceId: Workspace = "ws_real") {
    const operationId = `op_${sessionId}`
    await store.reserveSession(owner, { operationId, sessionId, workspaceId, kind: "create" })
    await store.registerRuntimeSession({
      principalKind: "user", actorId: owner.user.tokenIdentifier, actorKind: "human", operationId, sessionId, workspaceId,
    })
    if (!store.grantSessionShare) throw new Error("the SQLite authority grants session shares")
    await store.grantSessionShare(owner, {
      sessionId, workspaceId, grantedToTokenIdentifier: member.user.tokenIdentifier, level: "send",
    })
  }

  async function acquire(who: SignedControlPlaneAuth, sessionId: string, turnId: string, workspaceId: Workspace = "ws_real") {
    const response = await post({ action: "turn_acquire", sessionId, turnId }, await relayToken(who, workspaceId))
    if (response.status !== 200) throw new Error(`turn_acquire answered ${response.status}: ${await response.text()}`)
    const lease = await response.json() as { leaseId: string; fencingToken: number }
    return { sessionId, turnId, leaseId: lease.leaseId, fencingToken: lease.fencingToken }
  }

  return {
    orgId,
    outsiderOrgId,
    owner,
    member,
    outsider,
    store,
    ledger,
    target,
    post,
    relayToken,
    session,
    acquire,
    fetch: async (url: RequestInfo | URL, init?: RequestInit) =>
      await target.request(typeof url === "string" ? url : url instanceof URL ? url.href : url.url, init),
    revokeRuntimeAccessToken() {
      runtimeAccessTokenActive = false
    },
    close() {
      store.close()
      seed.close()
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

export type UsageReportPlane = Awaited<ReturnType<typeof usageReportPlane>>
