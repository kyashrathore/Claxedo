import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { d1Authority } from "./d1-authority"
import { createSqliteUsageLedger } from "@claxedo/server-core/usage/adapters/sqlite-usage-ledger"
import type { UsageReportWriter } from "@claxedo/server-core/usage/usage-report"
import { RuntimeSessionAuthorityRoutes } from "../routes/runtime-session-authority"

export const USAGE_REPORT_URL = "https://plane.test/api/runtime-authority/session-authorize"

type Workspace = "ws_real" | "ws_machine"

export async function usageReportPlane(input: { usageWriter?: boolean | UsageReportWriter } = {}) {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const env = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
    CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey),
  }
  const fixture = await d1Authority()
  const store = fixture.authority
  const owner = await fixture.signIn("owner")
  const member = await fixture.signIn("member")
  const outsider = await fixture.signIn("outsider")
  const { org_id: orgId } = await store.usersMe(owner) as { org_id: string }
  await store.usersMe(member)
  const { org_id: outsiderOrgId } = await store.usersMe(outsider) as { org_id: string }
  await store.createCloudWorkspace(owner, { workspaceId: "ws_real", displayName: "Main" })
  await store.registerLocalForSharing(owner, { workspaceId: "ws_machine", displayName: "Laptop", remoteDirectory: "/work/laptop" })
  await fixture.addMember(owner, member, orgId)

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
    actorId: who.principal!.actorId,
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
      createdAt: Date.now(),
      updatedAt: Date.now(),
      principalKind: "user", actorId: owner.principal!.actorId, actorKind: "human", operationId, sessionId, workspaceId,
    })
    await store.grantSessionShare!(owner, {
      sessionId, workspaceId, grantedToUserId: member.principal!.userId, level: "send",
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
    close: fixture.dispose,
  }
}

export type UsageReportPlane = Awaited<ReturnType<typeof usageReportPlane>>
