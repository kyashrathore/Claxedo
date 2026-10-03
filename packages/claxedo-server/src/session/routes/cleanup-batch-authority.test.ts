import { afterEach, describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { claxedoMcpToolGroupInventory } from "@claxedo/mcp"
import { builtinPluginInstanceId } from "@claxedo/server-core/agent-plugins/builtin/plugin"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { SessionCleanupTarget } from "@claxedo/agent-runtime-contract"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { inviteOrgMember } from "../../test-support/invite-org-member"
import { D1WorkspaceAuthority } from "../../authority/adapters/d1/workspace-authority"
import { D1SessionAuthority } from "../../authority/adapters/d1/session-authority"
import { D1ChannelRuntimeAuthority } from "../../authority/adapters/d1/channel-runtime-authority"
import { publishD1CloudSessionRows } from "../../authority/adapters/d1/cloud-session-rows"
import { cleanupOrigin } from "../../authority/adapters/d1/session-cleanup-origin"
import { D1SignedAgentPluginActivationStore } from "../../agent-plugins/activation/d1-store"
import { createBuiltinGroupReader } from "../../agent-plugins/runtime/cloud-root-environment"
import { createD1SandboxPassRegister } from "../../platform/auth/d1-sandbox-pass-register"
import { mintSessionCleanupCapability, SESSION_CLEANUP_AUDIENCE, type SessionCleanupCapabilityInput } from "../cleanup-capability"
import { createHostedSessionCleanupRoutes } from "./session-cleanup"
import type { ControlPlaneServices } from "../../authority/services"

const active: ControlPlaneDatabase[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(active.splice(0).map((row) => row.dispose())) })

async function fixture() {
  const instance = await miniflareControlPlaneDatabase()
  active.push(instance)
  const database = instance.database
  let clock = Date.now()
  let sequence = 0
  const now = () => clock
  const randomId = (prefix: string) => `${prefix}-${++sequence}`
  const workspace = new D1WorkspaceAuthority(database, { deploymentId: "cleanup-test", product: { kind: "claxedo-hosted" }, now, randomId })
  const sessions = new D1SessionAuthority(database, { deploymentId: "cleanup-test", now, randomId })
  const owners = new D1ChannelRuntimeAuthority(database, { deploymentId: "cleanup-test", now, randomId: () => randomId("channel") })
  const signed = async (subject: string): Promise<SignedControlPlaneAuth> => {
    const identity = { adapter: "better-auth" as const, issuer: "https://auth.cleanup.test", subject }
    const result = await workspace.ensureApplicationIdentity(identity)
    if (result.state !== "active") throw new Error("Fixture principal did not activate")
    return { mode: "signed", user: { subject, issuer: identity.issuer, tokenIdentifier: `${identity.issuer}|${subject}` }, principal: {
      userId: result.userId, actorId: result.actorId, actorKind: "human", deploymentId: "cleanup-test", sessionId: `auth-${subject}`,
      authenticatedAt: clock, methods: ["oauth:github"], assurance: "single-factor", identity,
      client: { kind: "browser", tokenKind: "browser-session", id: "browser", resource: "https://control.cleanup.test", scopes: ["openid"], origin: "https://app.cleanup.test" },
    } }
  }
  const alice = await signed("alice")
  const bob = await signed("bob")
  await workspace.createHostedOrganization(alice, { orgId: "cleanup-org", name: "Cleanup" })
  // The activation authority requires one selected organization; this fixture
  // retires the bootstrap personal organization before using the shared one.
  await database.prepare("UPDATE orgs SET deleted_at = ? WHERE owner_user_id = ? AND kind = 'personal'")
    .bind(now(), alice.principal!.userId).run()
  await inviteOrgMember(database, alice, { orgId: "cleanup-org", userPublicId: bob.principal!.userId, role: "member" })
  const row = await workspace.createWorkspace(alice, { workspaceId: "cleanup-workspace", orgId: "cleanup-org", displayName: "Cleanup", repoUrl: "https://github.com/cleanup/project.git", backing: "cloud-vm" })
  await database.prepare("INSERT INTO project_memberships (project_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'editor', 1, 1)")
    .bind(row.project_id, bob.principal!.userId).run()
  const facts = { sequence: 5, generation: 1, activitySequence: 5, activityAt: 5, working: false, awaitingInput: false }
  for (const sessionId of ["origin", "target-a", "target-b"]) {
    await sessions.reserveSession(alice, { operationId: `create-${sessionId}`, sessionId, workspaceId: row.workspace_id, kind: "create" })
    await sessions.registerRuntimeSession({ operationId: `create-${sessionId}`, sessionId, workspaceId: row.workspace_id, principalKind: "user", actorId: alice.principal!.actorId, actorKind: "human", createdAt: 1, updatedAt: 5 })
  }
  await database.prepare("INSERT INTO sandbox_leases (workspace_id, lease_id, epoch, status, driver, created_at, updated_at) VALUES (?, 'cleanup-runtime', 1, 'ready', 'cloudflare', 1, 1)")
    .bind(row.workspace_id).run()
  for (const sessionId of ["origin", "target-a", "target-b"]) {
    const published = await publishD1CloudSessionRows(database, now(), {
      workspaceId: row.workspace_id, hostId: "cleanup-runtime", epoch: 1, userId: alice.principal!.userId, actorId: alice.principal!.actorId,
      orgId: row.org_id, projectId: row.project_id,
    }, { rows: [{ sessionId, workspaceId: row.workspace_id, createdAt: 1, updatedAt: 5, attention: facts, status: { kind: "idle", awaitingInput: false, at: 5 } }], removed: [] })
    expect(published.refused).toEqual([])
  }
  const activations = new D1SignedAgentPluginActivationStore({ database, authority: workspace, now })
  const pluginInstanceId = builtinPluginInstanceId("session-cleanup")
  const consent = async (choice: boolean) => {
    const current = await activations.read(alice, { pluginInstanceId, harnessId: "opencode", projectId: row.project_id })
    await activations.mutateUser(alice, { pluginInstanceId, harnessIds: ["opencode"], target: { scope: "projects", projectIds: [row.project_id] }, choice, expectedRevision: current.revision })
  }
  await consent(true)
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const signingEnv = { CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey), CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey) }
  const passes = createD1SandboxPassRegister({ database, now })
  const scope = { userId: alice.principal!.userId, actorId: alice.principal!.actorId, orgId: row.org_id, projectId: row.project_id, workspaceId: row.workspace_id, sessionId: "origin" }
  const capability: SessionCleanupCapabilityInput = {
    signingEnv, passes, now, workspaceOwner: owners.resolveWorkspaceOwner.bind(owners),
    enabled: createBuiltinGroupReader({ activations, builtIn: { groups: claxedoMcpToolGroupInventory(), deployment: { inProcessServices: [] } } }, "session-cleanup"),
    originAllowed: (scope) => cleanupOrigin(database, scope.userId, scope.actorId, scope.workspaceId, scope.sessionId!),
  }
  const token = (await mintSessionCleanupCapability(scope, signingEnv, { register: passes, now, ttlSeconds: 60 })).token
  const admissions: string[] = []
  const dispatched: string[] = []
  let afterFirstDelete: (() => Promise<void>) | undefined
  let beforeDispatch: (() => Promise<void>) | undefined
  vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(request instanceof Request ? request.url : request.toString())
    const path = url.pathname.replace(`/workspaces/${row.workspace_id}`, "")
    const sessionId = path.split("/")[2]
    if (init?.method === "DELETE") {
      dispatched.push(sessionId)
      if (dispatched.length === 1) await afterFirstDelete?.()
      return Response.json({ ok: true, deletedSessionIds: [sessionId] })
    }
    if (path.endsWith("/children")) return Response.json([])
    return Response.json({ id: sessionId, title: sessionId, directory: "/workspace", time: { created: 1, updated: 5 }, attention: facts })
  })
  const services = { authority: {
    openRuntimeWorkspace: workspace.openRuntimeWorkspace.bind(workspace),
    listSessionCleanupPage: sessions.listSessionCleanupPage.bind(sessions),
    admitRuntimeSessionCleanup: async (...args: Parameters<D1SessionAuthority["admitRuntimeSessionCleanup"]>) => { admissions.push(args[1].sessionId); return sessions.admitRuntimeSessionCleanup(...args) },
  }, relay: { provider: {
    mintRuntimeAccessToken: async () => ({ token: "verified-relay-owner" }),
    getRelayEndpoint: async () => { const step = beforeDispatch; beforeDispatch = undefined; await step?.(); return "https://runtime.cleanup.test" },
  } }, sandbox: { sandboxManager: { target: async () => ({ status: "ready", hostId: "cleanup-runtime" }) } } } as unknown as ControlPlaneServices
  const app = createHostedSessionCleanupRoutes({ services, capability, authenticate: async () => Response.json({ error: "signed authentication unavailable" }, { status: 401 }) })
  const selected = await app.request("/api/claxedo/session-cleanup?seen=all&settled=all&archived=all", { headers: { authorization: `Bearer ${token}` } })
  expect(selected.status).toBe(200)
  const selection = await selected.json()
  expect(selection.incompleteSources).toEqual([])
  const targets: SessionCleanupTarget[] = ["target-a", "target-b"].map((id) => {
    const candidate = selection.candidates.find((item: { sessionId: string }) => item.sessionId === id)
    expect(candidate).toBeDefined()
    const { sessionId, workspaceId, generation, activitySequence, readerRevision, descendants } = candidate
    return { sessionId, workspaceId, generation, activitySequence, readerRevision, descendants }
  })
  const remove = () => app.request("/api/claxedo/session-cleanup/delete", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ targets, cascade: false }) })
  return { database, alice, bob, row, sessions, passes, scope, capability, consent, admissions, dispatched, remove,
    expire: () => { clock += 90_000 }, afterFirst: (step: () => Promise<void>) => { afterFirstDelete = step }, beforeDispatch: (step: () => Promise<void>) => { beforeDispatch = step } }
}

async function withdrawOrigin(f: Awaited<ReturnType<typeof fixture>>) {
  await f.sessions.grantSessionShare(f.alice, { sessionId: "origin", workspaceId: f.row.workspace_id, grantedToUserId: f.bob.principal!.userId, level: "send" })
  await f.sessions.acquireSessionTurn({ principalKind: "user", actorKind: "human", actorId: f.bob.principal!.actorId, sessionId: "origin", workspaceId: f.row.workspace_id, turnId: "bob-human-turn" })
  expect(await cleanupOrigin(f.database, f.scope.userId, f.scope.actorId, f.scope.workspaceId, "origin")).toBe(false)
}

describe("hosted cleanup batches retain current delegated authority", () => {
  test("deletes both exact targets while canonical consent and origin remain valid", async () => {
    const f = await fixture()
    expect(await (await f.remove()).json()).toMatchObject({ results: [{ sessionId: "target-a", status: "deleted" }, { sessionId: "target-b", status: "deleted" }] })
    expect(f.admissions).toEqual(["target-a", "target-b"])
    expect(f.dispatched).toEqual(["target-a", "target-b"])
  })

  test.each(["origin", "consent", "pass", "expiry", "actor"] as const)("withdrawal of %s after the first result refuses the next target before admission", async (kind) => {
    const f = await fixture()
    f.afterFirst(async () => {
      if (kind === "origin") await withdrawOrigin(f)
      if (kind === "consent") await f.consent(false)
      if (kind === "pass") expect(await f.passes.revoke({ workspaceId: f.scope.workspaceId, audience: SESSION_CLEANUP_AUDIENCE, reason: "withdrawn" })).toBe(1)
      if (kind === "expiry") f.expire()
      if (kind === "actor") await f.database.prepare("UPDATE actors SET state = 'suspended' WHERE actor_id = ?").bind(f.scope.actorId).run()
    })
    const response = await f.remove()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ results: [
      { sessionId: "target-a", status: "deleted", deletedSessionIds: ["target-a"] },
      { sessionId: "target-b", status: "failed", code: kind === "pass" || kind === "expiry" ? "session_cleanup_grant_invalid" : "session_cleanup_grant_withdrawn" },
    ] })
    expect(f.admissions).toEqual(["target-a"])
    expect(f.dispatched).toEqual(["target-a"])
  })

  test("consent withdrawn during relay endpoint lookup refuses an admitted target without dispatch or unknown receipt", async () => {
    const f = await fixture()
    f.beforeDispatch(() => f.consent(false))
    expect(await (await f.remove()).json()).toMatchObject({ results: [
      { sessionId: "target-a", status: "failed", code: "session_cleanup_grant_withdrawn" },
      { sessionId: "target-b", status: "failed", code: "session_cleanup_grant_withdrawn" },
    ] })
    expect(f.admissions).toEqual(["target-a"])
    expect(f.dispatched).toEqual([])
  })
})
