import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken, type RelayBacking } from "@claxedo/workspace-relay"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import type { SandboxTargetResult } from "@claxedo/sandbox-manager"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { runtimeAccessTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "../credentials/worker/index"
import { RuntimeSessionAuthorityRoutes } from "../routes/runtime-session-authority"
import type { ControlPlaneServices } from "../authority/services"
import type { RuntimeConfigSnapshotPlugins } from "@claxedo/harness/contract"
import { CLAXEDO_MCP_TOOL_GROUPS } from "@claxedo/mcp"
import { createClaxedoMcpClient } from "@claxedo/mcp/client"
import { d1Authority } from "./d1-authority"
import { firstPartyMcpContribution } from "../mcp/first-party-mcp"
import { sessionMcpCredentials } from "../mcp/session-mcp-credentials"
import { ownerSessionList } from "../session/list"

export const SESSION_AUTHORIZE_URL = "https://plane.test/api/runtime-authority/session-authorize"
export const WORKSPACE_ID = "ws_cloud"
export const DIRECTORY = "/workspace/repo"

/**
 * A control plane on real D1 serving one cloud workspace, its owner, a member
 * of the owner's organization and an outsider, with the session authority,
 * the session-host turn routes and the first-party MCP endpoint mounted as the
 * hosted Worker mounts them.
 */
export async function sessionHostPlane(input: {
  plugins?: (workspaceId: string) => Promise<RuntimeConfigSnapshotPlugins>
  relayUrl?: string
  toolGroups?: readonly string[]
} = {}) {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const env = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
    CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey),
    [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 7).toString("base64"),
    [HOSTED_CREDENTIALS_FLAG]: "1",
  }
  const fixture = await d1Authority()
  const store = fixture.authority
  const owner = await fixture.signIn("owner")
  const member = await fixture.signIn("member")
  const outsider = await fixture.signIn("outsider")
  const { org_id: orgId } = await store.usersMe(owner) as { org_id: string }
  await store.usersMe(member)
  await store.usersMe(outsider)
  await store.createCloudWorkspace(owner, { workspaceId: WORKSPACE_ID, displayName: "Cloud", remoteDirectory: DIRECTORY })
  await fixture.addMember(owner, member, orgId)
  const credentials = (org: string) => hostedOrgCredentials(org, { database: fixture.database, env })
  let target: SandboxTargetResult = { status: "unavailable", reason: "runtime_lease_not_ready", leaseStatus: "acquiring", retryAfterMs: 1_500 }
  const signRuntimeAccessToken = runtimeAccessTokenSigner(env)

  const services = { sandbox: { sandboxManager: { target: async () => target } }, defaultHomeRegion: "us-east" } as unknown as ControlPlaneServices
  const machine = { sessionHosts: store, services, relayEndpoint: () => input.relayUrl ?? "https://relay.test/", signRuntimeAccessToken }
  const resolveWorkspaceOwner = (workspaceId: string) => store.resolveWorkspaceOwner!(workspaceId)
  const sessionMcp = sessionMcpCredentials({
    ...machine, env, resolveWorkspaceOwner, toolGroups: async () => input.toolGroups ?? ["sessions"],
    listSessions: (owner, workspaceId, limit) => ownerSessionList(store, owner, workspaceId, limit),
  })
  const app = new Hono().route("/api/runtime-authority", RuntimeSessionAuthorityRoutes({
    authority: store,
    turnAuthority: store,
    sessionHosts: store,
    env,
    sessionHostDelivery: {
      ...machine,
      resolveWorkspaceOwner,
      credentials,
      ...(input.plugins ? { plugins: input.plugins } : {}),
      sessionMcp,
    },
  }))
  const mcp = firstPartyMcpContribution({
    app,
    authority: undefined,
    options: { createClient: (client) => createClaxedoMcpClient(client), registerTools: CLAXEDO_MCP_TOOL_GROUPS },
    signedAuth: async () => undefined,
    auditFallback: () => {},
    sessionMcp,
  })
  app.route(mcp.path, mcp.routes)

  const post = async (path: string, body: Record<string, unknown>, bearer?: string) => await app.request(`https://plane.test/api/runtime-authority${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  })

  /** Records the Runtime Access Token a client holds, then the Relay Host Token the relay derives from it for one request. */
  async function relayProof(who: SignedControlPlaneAuth, input: { hostId: string; backing: RelayBacking; sessionId?: string; jti: string }) {
    await store.recordRuntimeAccessToken(who, {
      jti: input.jti,
      workspaceId: WORKSPACE_ID,
      hostId: input.hostId,
      actorId: who.principal!.actorId,
      actorKind: "human",
      role: "editor",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      expiresAt: Date.now() + 10 * 60_000,
    })
    return await mintRelayHostToken({
      principalKind: "user",
      actorId: who.principal!.actorId,
      actorKind: "human",
      orgId,
      workspaceId: WORKSPACE_ID,
      hostId: input.hostId,
      role: "editor",
      backing: input.backing,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      jti: `rht_${input.jti}`,
      parentJti: input.jti,
    }, key.privateKey, "EdDSA")
  }

  /** The owner's create through the host its reservation placed it in: the reservation, then that host's start and registration. */
  async function createSession(sessionId: string, input: { harnessId: string; hostId: string; backing: RelayBacking }) {
    await store.reserveSession(owner, { operationId: `op_${sessionId}`, sessionId, workspaceId: WORKSPACE_ID, kind: "create", harnessId: input.harnessId })
    const proof = await relayProof(owner, { hostId: input.hostId, backing: input.backing, jti: `rat_create_${sessionId}` })
    for (const action of ["start", "register"]) {
      const times = action === "register" ? { createdAt: Date.now(), updatedAt: Date.now() } : {}
      const answer = await post("/session-authorize", { action, sessionId, operationId: `op_${sessionId}`, ...times }, proof)
      if (answer.status !== 200) throw new Error(`${action} answered ${answer.status}: ${await answer.text()}`)
    }
    return proof
  }
  const createHostedSession = (root: string) => createSession(root, { harnessId: "pi", hostId: sessionHostId(root), backing: "durable-object" })
  const createVmSession = (sessionId: string) => createSession(sessionId, { harnessId: "codex", hostId: "host_vm", backing: "cloud-vm" })

  async function acquire(proof: string, sessionId: string, turnId: string) {
    const answer = await post("/session-authorize", { action: "turn_acquire", sessionId, turnId }, proof)
    if (answer.status !== 200) throw new Error(`turn_acquire answered ${answer.status}: ${await answer.text()}`)
    return await answer.json() as { leaseId: string; fencingToken: number; turnId: string }
  }

  return {
    app,
    env,
    key,
    orgId,
    owner,
    member,
    outsider,
    store,
    database: fixture.database,
    credentials,
    signRuntimeAccessToken,
    post,
    relayProof,
    createHostedSession,
    createVmSession,
    acquire,
    serve(next: SandboxTargetResult) {
      target = next
    },
    close: fixture.dispose,
  }
}

export type SessionHostPlane = Awaited<ReturnType<typeof sessionHostPlane>>
