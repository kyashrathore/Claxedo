import { afterEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { createRuntimeCredentialIssuer } from "@claxedo/workspace-runtime"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../../authority/services"
import { firstPartyMcpRuntimeContribution } from "../../hosts/workspace-runtime/first-party-mcp"
import { mintSessionCleanupCapability, verifySessionCleanupCapability, type SessionCleanupCapabilityInput } from "../cleanup-capability"
import { sessionCleanupGrantContribution } from "./cleanup-grant"
import { createHostedSessionCleanupRoutes } from "./session-cleanup"

const owner = { userId: "alice", actorId: "actor-alice", orgId: "org-a", projectId: "project-a" }
const root = { ...owner, workspaceId: "workspace-a" }
const signed: SignedControlPlaneAuth = { mode: "signed", token: "signed-alice", user: { subject: owner.userId, tokenIdentifier: "account-proof", issuer: "https://account.example" } }
const relayOwner = { role: "owner", workspace_id: root.workspaceId, principal_kind: "user", actor_kind: "human" }

afterEach(() => vi.unstubAllGlobals())

async function fixture() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const signingEnv = { CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey), CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey) }
  const issuer = createRuntimeCredentialIssuer({ runtimeId: "runtime-a", workspaceId: root.workspaceId })
  let relayClaims: Record<string, unknown> | undefined = relayOwner
  const contribution = firstPartyMcpRuntimeContribution({ verifyRuntimeCredential: issuer.verify, enabledToolGroups: [] })
  const mounted = contribution.mount({ workspaceId: root.workspaceId, directory: "/workspace", stateDirectory: "/state", fetch: async () => new Response(null, { status: 404 }), registerSessionTools: () => async () => {}, unregisterSessionTools: () => async () => {} })
  const runtime = new Hono()
  runtime.use("*", async (c, next) => {
    if (c.req.header("authorization") === "Bearer relay-owner" && relayClaims) c.set("relayHostAuth" as never, relayClaims as never)
    await next()
  })
  const actualParents = new Map<string, string | undefined>([["session-alice", undefined], ["session-bob", undefined]])
  const publishedParents = new Map(actualParents)
  runtime.route(mounted.path, mounted.routes).get("/session/:id", (c) => {
    const id = c.req.param("id")
    return actualParents.has(id) ? c.json({ id, ...(actualParents.get(id) ? { parentID: actualParents.get(id) } : {}) }) : c.json({ error: "missing" }, 404)
  })
  vi.stubGlobal("fetch", async (value: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(value instanceof Request ? value.url : value.toString())
    return runtime.request(url.pathname.replace(`/workspaces/${root.workspaceId}`, ""), init)
  })
  const listSessionCleanupPage = vi.fn(async () => [])
  const admitRuntimeSessionCleanup = vi.fn(async () => {})
  const services = { authority: {
    usersMe: async () => ({ actor_id: owner.actorId, actor_kind: "human" }),
    resolveOrgId: async () => owner.orgId,
    openRuntimeWorkspace: async () => ({ allowed: true, role: "owner", workspace: { workspace_id: root.workspaceId, org_id: owner.orgId, backing: "cloud-vm", home_region: "us-east" } }),
    listSessionCleanupPage, admitRuntimeSessionCleanup,
  }, relay: { provider: { getRelayEndpoint: async () => "http://runtime.example", mintRuntimeAccessToken: async () => ({ token: "relay-owner" }) } }, sandbox: { sandboxManager: { target: async () => ({ status: "ready", hostId: "host-a" }) } } } as unknown as ControlPlaneServices
  let enabled = true
  let desktopLive = true
  const deniedOrigins = new Set(["session-bob"])
  const capability: SessionCleanupCapabilityInput = { signingEnv, workspaceOwner: async () => owner, enabled: async () => enabled,
    originAllowed: async (scope) => !deniedOrigins.has(scope.sessionId!),
    originParentMatches: async (scope, parent) => publishedParents.has(scope.sessionId!) && publishedParents.get(scope.sessionId!) === parent,
    desktopOwner: async (scope) => desktopLive && scope.userId === owner.userId && scope.actorId === owner.actorId && scope.orgId === owner.orgId ? { ...owner, projectId: "all-projects" } : undefined,
  }
  const token = (await mintSessionCleanupCapability(root, signingEnv)).token
  const issuerRoutes = sessionCleanupGrantContribution({ ...capability, services }).routes
  const account = createHostedSessionCleanupRoutes({ services, capability, authenticate: async (request) => request.headers.get("authorization") === "Bearer signed-alice" ? signed : Response.json({ error: "unauthorized" }, { status: 401 }) })
  const issue = (sessionId: string, credential: string | undefined = issuer.current(sessionId)) => issuerRoutes.request("/session", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ sessionId, ...(credential ? { credential } : {}) }) })
  const query = (token: string) => account.request("/api/claxedo/session-cleanup", { headers: { authorization: `Bearer ${token}` } })
  return { signingEnv, issuer, mounted, runtime, account, token, issue, query, deniedOrigins, actualParents, publishedParents, listSessionCleanupPage, admitRuntimeSessionCleanup,
    relay: (value: Record<string, unknown> | undefined) => { relayClaims = value }, enabled: (value: boolean) => { enabled = value }, desktopLive: (value: boolean) => { desktopLive = value } }
}

describe("cleanup origin proof at the control plane and runtime boundaries", () => {
  test("issues and admits a grant only for the independently verified runtime session", async () => {
    const f = await fixture()
    try {
      const issued = await f.issue("session-alice")
      expect(issued.status).toBe(200)
      const body = await issued.json() as { token: string }
      expect(await verifySessionCleanupCapability(body.token, f.signingEnv)).toEqual({ ...root, sessionId: "session-alice" })
      expect((await f.query(body.token)).status).toBe(200)
      expect(f.listSessionCleanupPage).toHaveBeenCalledWith({ userId: owner.userId, actorId: owner.actorId, orgId: owner.orgId }, expect.objectContaining({ all: true }))
      expect((await f.issue("session-alice", f.issuer.current("session-bob"))).status).toBe(403)
      expect((await f.issue("session-bob")).status).toBe(403)
      const wrongWorkspace = createRuntimeCredentialIssuer({ runtimeId: "runtime-a", workspaceId: "workspace-other" })
      expect((await f.issue("session-alice", wrongWorkspace.current("session-alice"))).status).toBe(403)
      expect((await f.issue("session-alice", "")).status).toBe(400)
    } finally { f.mounted.dispose() }
  })

  test("requires complete actual ancestor publication before issuing a child grant", async () => {
    const f = await fixture()
    try {
      f.actualParents.set("child", "parent")
      f.actualParents.set("parent", "grandparent")
      f.actualParents.set("grandparent", undefined)
      f.publishedParents.set("child", "parent")
      f.publishedParents.set("parent", undefined)
      expect((await f.issue("child")).status).toBe(409)
      f.publishedParents.set("parent", "grandparent")
      expect((await f.issue("child")).status).toBe(409)
      f.publishedParents.set("grandparent", undefined)
      expect((await f.issue("child")).status).toBe(200)
      f.actualParents.set("grandparent", "child")
      f.publishedParents.set("grandparent", "child")
      expect((await f.issue("child")).status).toBe(409)
    } finally { f.mounted.dispose() }
  })

  test("rejects root issuer tokens and withdraws a scoped grant on foreign human activity", async () => {
    const f = await fixture()
    try {
      expect((await f.query(f.token)).status).toBe(403)
      expect((await f.account.request("/api/claxedo/session-cleanup/delete", { method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" }, body: JSON.stringify({ targets: [], cascade: true }) })).status).toBe(403)
      const issued = await f.issue("session-alice")
      const { token } = await issued.json() as { token: string }
      f.deniedOrigins.add("session-alice")
      expect((await f.query(token)).status).toBe(403)
      expect((await f.account.request("/api/claxedo/session-cleanup/delete", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ targets: [], cascade: true }) })).status).toBe(403)
      expect(f.listSessionCleanupPage).not.toHaveBeenCalled()
      expect(f.admitRuntimeSessionCleanup).not.toHaveBeenCalled()
    } finally { f.mounted.dispose() }
  })

  test.each([undefined, { ...relayOwner, role: "editor" }, { ...relayOwner, workspace_id: "other" }, { ...relayOwner, session_id: "session-alice" }, { ...relayOwner, principal_kind: "service", actor_kind: "agent" }])("runtime proof lookup refuses a caller outside current workspace owner authority: %j", async (claims) => {
    const f = await fixture()
    try {
      f.relay(claims)
      const response = await f.runtime.request("/api/claxedo/session-cleanup/credential", { method: "POST", headers: { authorization: "Bearer relay-owner", "content-type": "application/json" }, body: JSON.stringify({ credential: f.issuer.current("session-alice") }) })
      expect(response.status).toBe(403)
    } finally { f.mounted.dispose() }
  })
})

describe("signed desktop cleanup account consent", () => {
  test("issues without a host or session and binds the canonical signed owner and organization", async () => {
    const f = await fixture()
    try {
      const response = await f.account.request("/api/claxedo/session-cleanup/grant/desktop", { method: "POST", headers: { authorization: "Bearer signed-alice", "content-type": "application/json" }, body: "{}" })
      expect(response.status).toBe(200)
      const body = await response.json() as { token: string; actorId: string; orgId: string; expiresAt: number }
      expect(body).toMatchObject({ actorId: owner.actorId, orgId: owner.orgId, expiresAt: expect.any(Number) })
      expect(body.expiresAt).toBeGreaterThan(Date.now())
      expect(await verifySessionCleanupCapability(body.token, f.signingEnv)).toEqual({ ...owner, workspaceId: "desktop", projectId: "all-projects", desktop: true })
      expect((await f.query(body.token)).status).toBe(200)
      f.enabled(false)
      expect((await f.query(body.token)).status).toBe(403)
      const disabled = await f.account.request("/api/claxedo/session-cleanup/grant/desktop", { method: "POST", headers: { authorization: "Bearer signed-alice", "content-type": "application/json" }, body: "{}" })
      expect(disabled.status).toBe(403)
      f.enabled(true)
      f.desktopLive(false)
      expect((await f.query(body.token)).status).toBe(403)
    } finally { f.mounted.dispose() }
  })

  test("refuses runtime proof, injected actor, and an organization outside live signed membership", async () => {
    const f = await fixture()
    try {
      const request = (body: object, token = "signed-alice") => f.account.request("/api/claxedo/session-cleanup/grant/desktop", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
      expect((await request({}, f.token)).status).toBe(401)
      expect((await request({ actorId: "actor-bob" })).status).toBe(400)
      expect((await request({ orgId: "org-b" })).status).toBe(403)
    } finally { f.mounted.dispose() }
  })
})
