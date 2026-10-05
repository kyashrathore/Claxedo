import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { decodeJwt, importPKCS8, SignJWT } from "jose"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { parseTurnDelivery } from "@claxedo/harness/contract"
import { WORKSPACE_ID, sessionHostPlane, type SessionHostPlane } from "../test-support/session-host-plane"

const ROOT = "ses_pi_mcp"
const OTHER = "ses_pi_other"
const VM = "ses_vm_mcp"
const VM_HOST = "host_vm"

let plane: SessionHostPlane
let relay: Server
const relayed: Array<{ path: string; authorization: string | undefined }> = []

beforeAll(async () => {
  relay = createServer((request, response) => {
    relayed.push({ path: request.url ?? "", authorization: request.headers.authorization })
    response.writeHead(200, { "content-type": "application/json" }).end(request.url?.includes("/status") ? "{}" : "[]")
  })
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve))
  plane = await sessionHostPlane({ relayUrl: `http://127.0.0.1:${(relay.address() as AddressInfo).port}/` })
  await plane.createHostedSession(ROOT)
  await plane.createHostedSession(OTHER)
  await plane.createVmSession(VM)
  plane.serve({ status: "ready", workspaceId: WORKSPACE_ID, sandboxId: "sbx", url: "https://vm.test", hostId: VM_HOST, epoch: 1, homeRegion: "us-east" })
})

afterAll(async () => {
  await plane.close()
  await new Promise<void>((resolve) => relay.close(() => resolve()))
})

async function delivered(sessionId: string) {
  const proof = await plane.relayProof(plane.owner, { hostId: sessionHostId(sessionId), backing: "durable-object", jti: `rat_mcp_${crypto.randomUUID()}` })
  const lease = await plane.acquire(proof, sessionId, `turn_${crypto.randomUUID()}`)
  const answer = await plane.post("/turn-delivery", { turnLease: lease.leaseId })
  expect(answer.status).toBe(200)
  const delivery = parseTurnDelivery(await answer.json())
  await plane.post("/session-authorize", { action: "turn_release", sessionId, turnId: lease.turnId, leaseId: lease.leaseId, fencingToken: lease.fencingToken }, proof)
  if (!delivery?.firstPartyMcp) throw new Error(`The delivery for ${sessionId} carried no first-party MCP server`)
  return { ...delivery.firstPartyMcp, lease }
}

const mcpRequest = (url: string, token: string) => plane.app.request(url, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "0" } } }),
})

async function connect(url: string, token: string) {
  const client = new Client({ name: "fixture", version: "0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    fetch: (input, init) => Promise.resolve(plane.app.request(input.toString(), init)),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }))
  return client
}

async function signedSessionToken(claims: Record<string, unknown>, expiresInSeconds: number) {
  const now = Math.floor(Date.now() / 1000)
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer("claxedo-control-plane")
    .setAudience("claxedo-session-mcp")
    .setSubject(`session:${String(claims.session_id)}`)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + expiresInSeconds)
    .setJti(crypto.randomUUID())
    .sign(await importPKCS8(plane.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM, "EdDSA"))
}

describe("the first-party MCP credential of a session served by its own host", () => {
  test("each turn's delivery names the endpoint for that session with a bearer only the MCP endpoint accepts", async () => {
    const mcp = await delivered(ROOT)
    expect(mcp).toMatchObject({ name: "claxedo", url: `https://plane.test/api/claxedo/mcp?session=${ROOT}` })
    expect(decodeJwt(mcp.token)).toMatchObject({
      aud: "claxedo-session-mcp", sub: `session:${ROOT}`, session_id: ROOT, workspace_id: WORKSPACE_ID, user_id: plane.owner.principal!.userId,
    })
    expect(mcp.token).not.toBe(mcp.lease.leaseId)
  })

  test("the session lists its consented tools and calls one on its own workspace's machine with an owner token recorded for it", async () => {
    const mcp = await delivered(ROOT)
    const client = await connect(mcp.url, mcp.token)
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain("sessions_list")
    expect(names.some((name) => name.startsWith("task"))).toBe(false)
    const result = await client.callTool({ name: "sessions_list", arguments: {} })
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({ workspaces: [{ workspace: WORKSPACE_ID, sessions: [] }] })
    const bearer = relayed.at(-1)?.authorization?.replace(/^Bearer /, "") ?? ""
    expect(relayed.at(-1)?.path).toMatch(new RegExp(`^/workspaces/${WORKSPACE_ID}/session`))
    const token = decodeJwt(bearer)
    expect(token).toMatchObject({ aud: "workspace-relay", host_id: VM_HOST, role: "editor", actor_id: plane.owner.principal!.actorId })
    expect(token.session_id).toBeUndefined()
    expect(await plane.store.runtimeAccessTokenActive({ jti: String(token.jti), workspaceId: WORKSPACE_ID, hostId: VM_HOST })).toEqual({ active: true })
    const elsewhere = await client.callTool({ name: "sessions_list", arguments: { workspace: "ws_elsewhere" } })
    expect(JSON.parse((elsewhere.content as Array<{ text: string }>)[0].text)).toEqual({
      workspaces: [{ workspace: "ws_elsewhere", unavailable: "Reaching workspace ws_elsewhere needs an account credential and none is reachable" }],
    })
    expect(relayed.filter((request) => request.path.includes("ws_elsewhere"))).toEqual([])
  })

  test("a tool aimed at the session itself reaches its own host with a token for that host alone, never the machine", async () => {
    const mcp = await delivered(ROOT)
    const client = await connect(mcp.url, mcp.token)
    const before = relayed.length
    const result = await client.callTool({ name: "session_transcript", arguments: { session: ROOT } })
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({ messages: [] })
    const calls = relayed.slice(before)
    expect(calls.map((call) => call.path.split("?")[0])).toEqual([`/workspaces/${WORKSPACE_ID}/session/${ROOT}/message`])
    const token = decodeJwt(calls[0]?.authorization?.replace(/^Bearer /, "") ?? "")
    expect(token).toMatchObject({ aud: "workspace-relay", host_id: sessionHostId(ROOT), session_id: ROOT, role: "editor", actor_id: plane.owner.principal!.actorId })
    expect(await plane.store.runtimeAccessTokenActive({ jti: String(token.jti), workspaceId: WORKSPACE_ID, hostId: sessionHostId(ROOT) })).toEqual({ active: true })
  })

  test("a later turn's bearer calls a tool with no MCP session, over the owner token the session already holds", async () => {
    const first = await delivered(ROOT)
    await (await connect(first.url, first.token)).callTool({ name: "sessions_list", arguments: {} })
    const held = relayed.at(-1)?.authorization
    const later = await delivered(ROOT)
    expect(later.token).not.toBe(first.token)
    const called = await plane.app.request(later.url, {
      method: "POST",
      headers: { authorization: `Bearer ${later.token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "sessions_list", arguments: {} } }),
    })
    expect(called.headers.get("mcp-session-id")).toBeNull()
    expect(await called.json()).toMatchObject({ id: 2, result: { content: [{ type: "text", text: expect.stringContaining(WORKSPACE_ID) }] } })
    expect(relayed.at(-1)?.authorization).toBe(held)
  })

  test("another session's address, an expired token, a token for another endpoint and a forged scope are refused", async () => {
    const mcp = await delivered(ROOT)
    expect((await mcpRequest(mcp.url, mcp.token)).status).toBe(200)
    expect((await mcpRequest(mcp.url.replace(ROOT, OTHER), mcp.token)).status).toBe(401)
    const claims = { user_id: plane.owner.principal!.userId, org_id: plane.orgId, workspace_id: WORKSPACE_ID, session_id: ROOT }
    expect((await mcpRequest(mcp.url, await signedSessionToken(claims, -1))).status).toBe(401)
    expect((await mcpRequest(mcp.url, await signedSessionToken({ ...claims, user_id: plane.member.principal!.userId }, 300))).status).toBe(401)
    expect((await mcpRequest(mcp.url, await signedSessionToken({ ...claims, session_id: VM }, 300))).status).toBe(401)
    const relayProof = await plane.relayProof(plane.owner, { hostId: sessionHostId(ROOT), backing: "durable-object", jti: "rat_mcp_other_endpoint" })
    expect((await mcpRequest(mcp.url, relayProof)).status).toBe(401)
    expect((await mcpRequest(mcp.url, mcp.lease.leaseId)).status).toBe(401)
    expect((await plane.post("/session-authorize", { action: "read", sessionId: ROOT }, mcp.token)).status).toBe(401)
    expect((await plane.post("/turn-execution", { turnLease: mcp.token })).status).toBe(401)
  })

  test("a deleted session's bearer is refused, and no owner token is recorded for it", async () => {
    const root = "ses_pi_mcp_deleted"
    await plane.createHostedSession(root)
    const mcp = await delivered(root)
    expect((await mcpRequest(mcp.url, mcp.token)).status).toBe(200)
    await plane.store.deleteHostedSession({ workspaceId: WORKSPACE_ID, sessionId: root })
    expect((await mcpRequest(mcp.url, mcp.token)).status).toBe(401)
    const record = { jti: "rat_mcp_deleted", workspaceId: WORKSPACE_ID, hostId: VM_HOST, sessionId: root, expiresAt: Date.now() + 60_000 }
    await expect(plane.store.recordSessionMcpRuntimeAccessToken(plane.owner.principal!.actorId, record)).rejects.toThrow()
  })

  test("the owner token is recorded only for the workspace owner, for a live session served by its own host, on the machine", async () => {
    const expiresAt = Date.now() + 60_000
    const record = (jti: string, sessionId: string, hostId = VM_HOST) => ({ jti, workspaceId: WORKSPACE_ID, hostId, sessionId, expiresAt })
    await expect(plane.store.recordSessionMcpRuntimeAccessToken(plane.member.principal!.actorId, record("rat_mcp_member", ROOT))).rejects.toThrow()
    await expect(plane.store.recordSessionMcpRuntimeAccessToken(plane.owner.principal!.actorId, record("rat_mcp_vm", VM))).rejects.toThrow()
    await expect(plane.store.recordSessionMcpRuntimeAccessToken(plane.owner.principal!.actorId, record("rat_mcp_host", ROOT, sessionHostId(ROOT)))).rejects.toThrow()
    await plane.store.recordSessionMcpRuntimeAccessToken(plane.owner.principal!.actorId, record("rat_mcp_owner", ROOT))
    expect(await plane.store.runtimeAccessTokenActive({ jti: "rat_mcp_owner", workspaceId: WORKSPACE_ID, hostId: VM_HOST })).toEqual({ active: true })
  })

  test("the owner's session-host token is recorded only for the workspace owner, for that live session's own host", async () => {
    const expiresAt = Date.now() + 60_000
    const record = (jti: string, sessionId: string, hostId = sessionHostId(sessionId)) => ({ jti, workspaceId: WORKSPACE_ID, hostId, sessionId, expiresAt })
    const owner = plane.owner.principal!.actorId
    await expect(plane.store.recordSessionMcpSessionHostAccessToken(plane.member.principal!.actorId, record("rat_mcph_member", ROOT))).rejects.toThrow()
    await expect(plane.store.recordSessionMcpSessionHostAccessToken(owner, record("rat_mcph_vm", VM))).rejects.toThrow()
    await expect(plane.store.recordSessionMcpSessionHostAccessToken(owner, record("rat_mcph_machine", ROOT, VM_HOST))).rejects.toThrow()
    await expect(plane.store.recordSessionMcpSessionHostAccessToken(owner, record("rat_mcph_other", ROOT, sessionHostId(OTHER)))).rejects.toThrow()
    await plane.store.recordSessionMcpSessionHostAccessToken(owner, record("rat_mcph_owner", ROOT))
    expect(await plane.store.runtimeAccessTokenActive({ jti: "rat_mcph_owner", workspaceId: WORKSPACE_ID, hostId: sessionHostId(ROOT) })).toEqual({ active: true })
  })
})
