import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createServer, type Server } from "node:http"
import { connect } from "node:net"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { exportJWK, generateKeyPair } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"

import { createHostRuntimeListener, type HostRuntimeListener } from "./runtime"

const HOST_ID = "host_machine-1"
const WS_A = "11111111-1111-4111-8111-111111111111"
const WS_B = "22222222-2222-4222-8222-222222222222"
const KID = "relay-host-current"

type AuthorityCall = { authorization: string | undefined; body: Record<string, unknown> }

/** The relay's published key set and the control plane's session authority, both faked on loopback. */
function listen(server: Server) {
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("no port")
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

describe("host workspace runtime behind the loopback listener", () => {
  let key: Awaited<ReturnType<typeof generateKeyPair>>
  let jwks: Server
  let authority: Server
  let jwksUrl: string
  let sessionAuthorityUrl: string
  let listener: HostRuntimeListener
  let root: string
  const authorityCalls: AuthorityCall[] = []
  let authorityVerdict: { status: number; body: unknown } = { status: 200, body: {} }

  beforeAll(async () => {
    key = await generateKeyPair("EdDSA", { extractable: true })
    const jwk = { ...(await exportJWK(key.publicKey)), kid: KID, alg: "EdDSA", use: "sig" }
    jwks = createServer((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ keys: [jwk] }))
    })
    authority = createServer((request, response) => {
      let raw = ""
      request.on("data", (chunk) => { raw += chunk })
      request.on("end", () => {
        authorityCalls.push({ authorization: request.headers.authorization, body: JSON.parse(raw) })
        response.statusCode = authorityVerdict.status
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify(authorityVerdict.body))
      })
    })
    jwksUrl = `${await listen(jwks)}/.well-known/jwks.json`
    sessionAuthorityUrl = `${await listen(authority)}/api/runtime-authority/session-authorize`
    root = await fs.mkdtemp(path.join(os.tmpdir(), "host-serving-runtime-"))
    listener = await createHostRuntimeListener({ hostname: "127.0.0.1", port: 0, drainTimeoutMs: 2_000 })
    for (const workspaceId of [WS_A, WS_B]) {
      const directory = path.join(root, workspaceId)
      await fs.mkdir(directory, { recursive: true })
      await listener.ensure({
        workspaceId,
        directory,
        hostId: HOST_ID,
        relay: { jwksUrl },
        sessionAuthorityUrl,
        storeRoot: path.join(root, "state", workspaceId),
      })
    }
  })

  afterAll(async () => {
    await listener?.close()
    await new Promise<void>((resolve) => jwks?.close(() => resolve()))
    await new Promise<void>((resolve) => authority?.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  })

  async function relayHostToken(input: { workspaceId: string; hostId?: string; kid?: string } ) {
    return mintRelayHostToken({
      principalKind: "user",
      actorId: "user_1",
      actorKind: "human",
      actorPublicId: "public_1",
      actorName: "Test User",
      orgId: "org_1",
      workspaceId: input.workspaceId,
      hostId: input.hostId ?? HOST_ID,
      role: "editor",
      parentJti: "rat_jti_1",
      access: "user-hosted",
      backing: "local-worktree",
      kid: input.kid ?? KID,
    }, key.privateKey, "EdDSA")
  }

  /** What the tunnel hands the listener: the relay's forwarded headers plus the caller's token. */
  function relayed(token: string, workspaceId: string) {
    return {
      authorization: `Bearer ${token}`,
      "x-workspace-id": workspaceId,
      "x-forwarded-by": "workspace-relay",
    }
  }

  test("routes /workspaces/<id>/global/health to that workspace's runtime and 404s an unknown id", async () => {
    expect(listener.workspaceIds()).toEqual([WS_A, WS_B])
    for (const workspaceId of [WS_A, WS_B]) {
      const response = await fetch(`${listener.url}/workspaces/${workspaceId}/global/health`)
      expect(response.status, workspaceId).toBe(200)
      expect(await response.json()).toMatchObject({ healthy: true })
    }
    const unknown = await fetch(`${listener.url}/workspaces/33333333-3333-4333-8333-333333333333/global/health`)
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ error: { code: "workspace_not_served" } })
    const bare = await fetch(`${listener.url}/global/health`)
    expect(bare.status).toBe(404)
  })

  test("a request without a Relay Host Token is refused at the relay-host boundary", async () => {
    const response = await fetch(`${listener.url}/workspaces/${WS_A}/session`, {
      headers: { "x-workspace-id": WS_A, "x-forwarded-by": "workspace-relay" },
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: "relay_host_token_required" } })
    expect(authorityCalls).toEqual([])
  })

  test("a token signed by a key the relay never published is refused", async () => {
    const other = await generateKeyPair("EdDSA", { extractable: true })
    const token = await mintRelayHostToken({
      principalKind: "user",
      actorId: "user_1",
      actorKind: "human",
      orgId: "org_1",
      workspaceId: WS_A,
      hostId: HOST_ID,
      role: "editor",
      parentJti: "rat_jti_1",
      access: "user-hosted",
      backing: "local-worktree",
      kid: KID,
    }, other.privateKey, "EdDSA")
    const response = await fetch(`${listener.url}/workspaces/${WS_A}/session`, { headers: relayed(token, WS_A) })
    expect(response.status).toBe(401)
    expect(authorityCalls).toEqual([])
  })

  test("a valid token for another workspace does not open this one", async () => {
    const token = await relayHostToken({ workspaceId: WS_B })
    const response = await fetch(`${listener.url}/workspaces/${WS_A}/session`, { headers: relayed(token, WS_A) })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: "relay_token_workspace_mismatch" } })
    expect(authorityCalls).toEqual([])
  })

  test("a relayed request with a valid token reaches the runtime; a private-session read asks the authority URL with the caller's token", async () => {
    const token = await relayHostToken({ workspaceId: WS_A })
    const list = await fetch(`${listener.url}/workspaces/${WS_A}/session`, { headers: relayed(token, WS_A) })
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual([])

    authorityCalls.length = 0
    const read = await fetch(`${listener.url}/workspaces/${WS_A}/session/ses_missing`, { headers: relayed(token, WS_A) })
    // Admitted by the authority, then honestly absent: the runtime answered,
    // not the auth boundary.
    expect(read.status).toBe(404)
    expect(authorityCalls).toEqual([
      { authorization: `Bearer ${token}`, body: { sessionId: "ses_missing", action: "read" } },
    ])
  })

  test("the authority's refusal is the runtime's refusal", async () => {
    const token = await relayHostToken({ workspaceId: WS_A })
    authorityVerdict = { status: 403, body: { error: { code: "session_private", message: "no" } } }
    try {
      const read = await fetch(`${listener.url}/workspaces/${WS_A}/session/ses_missing`, { headers: relayed(token, WS_A) })
      expect(read.status).toBe(403)
      expect(await read.json()).toMatchObject({ error: { code: "session_private" } })
    } finally {
      authorityVerdict = { status: 200, body: {} }
    }
  })

  test("WebSocket upgrades are routed by workspace id and meet the same boundary", async () => {
    const upgrade = (target: string) => new Promise<string>((resolve, reject) => {
      const port = Number(new URL(listener.url).port)
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
          + `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
        )
      })
      let head = ""
      socket.on("data", (chunk) => {
        head += chunk.toString()
        if (head.includes("\r\n")) {
          socket.destroy()
          resolve(head.split("\r\n")[0])
        }
      })
      socket.on("error", reject)
    })
    expect(await upgrade(`/workspaces/33333333-3333-4333-8333-333333333333/event`)).toBe("HTTP/1.1 404 Not Found")
    expect(await upgrade(`/workspaces/${WS_A}/event`)).toBe("HTTP/1.1 401 Unauthorized")
  })

  test("dispose drains and removes one runtime while the other keeps serving", async () => {
    await listener.dispose(WS_B)
    expect(listener.workspaceIds()).toEqual([WS_A])
    const gone = await fetch(`${listener.url}/workspaces/${WS_B}/global/health`)
    expect(gone.status).toBe(404)
    const kept = await fetch(`${listener.url}/workspaces/${WS_A}/global/health`)
    expect(kept.status).toBe(200)
    await listener.dispose(WS_B)
  })

  test("ensure with a changed directory replaces the runtime for that id", async () => {
    const before = await listener.ensure({
      workspaceId: WS_A,
      directory: path.join(root, WS_A),
      hostId: HOST_ID,
      relay: { jwksUrl },
      sessionAuthorityUrl,
      storeRoot: path.join(root, "state", WS_A),
    })
    const moved = path.join(root, `${WS_A}-moved`)
    await fs.mkdir(moved, { recursive: true })
    const after = await listener.ensure({
      workspaceId: WS_A,
      directory: moved,
      hostId: HOST_ID,
      relay: { jwksUrl },
      sessionAuthorityUrl,
      storeRoot: path.join(root, "state", WS_A),
    })
    expect(after).not.toBe(before)
    expect(listener.workspaceIds()).toEqual([WS_A])
    const health = await fetch(`${listener.url}/workspaces/${WS_A}/global/health`)
    expect(health.status).toBe(200)
  })
})
