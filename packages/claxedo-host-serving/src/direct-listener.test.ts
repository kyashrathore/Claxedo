import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createServer, type Server } from "node:http"
import { request as httpsRequest } from "node:https"
import { connect as tlsConnect } from "node:tls"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { decodeJwt, exportJWK, generateKeyPair } from "jose"
import { mintRelayHostToken, mintRuntimeAccessToken } from "@claxedo/workspace-relay"
import { Pty } from "@claxedo/workspace-runtime"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { createDirectTlsKey, directTlsIdentity, type DirectTlsIdentity } from "./direct-certificate"
import { privateNetworkAddresses, startDirectListener, type DirectListener } from "./direct-listener"
import { createHostRuntimeListener, installHostProviderConfigAuthority, setHostProviderConfig, type HostRuntimeListener } from "./runtime"

const HOST_ID = "host_machine-1"
const WS_A = "11111111-1111-4111-8111-111111111111"
const WS_B = "22222222-2222-4222-8222-222222222222"

function listen(server: Server) {
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("no port")
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

type Answer = { status: number; body: Record<string, unknown> }

describe("the direct listener in front of the host runtimes", () => {
  let controlPlaneKey: Awaited<ReturnType<typeof generateKeyPair>>
  let relayKey: Awaited<ReturnType<typeof generateKeyPair>>
  let keys: Server
  let authority: Server
  let runtime: HostRuntimeListener
  let direct: DirectListener
  let identity: DirectTlsIdentity
  let port: number
  let root: string
  const revoked = new Set<string>()
  const hostReads: string[] = []
  const previousDataDir = process.env.CLAXEDO_DATA_DIR

  beforeAll(async () => {
    controlPlaneKey = await generateKeyPair("EdDSA", { extractable: true })
    relayKey = await generateKeyPair("EdDSA", { extractable: true })
    const controlPlaneKeys = { keys: [{ ...(await exportJWK(controlPlaneKey.publicKey)), alg: "EdDSA", use: "sig" }] }
    const relayKeys = { keys: [{ ...(await exportJWK(relayKey.publicKey)), kid: "relay", alg: "EdDSA", use: "sig" }] }
    keys = createServer((request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(request.url?.startsWith("/relay/") ? relayKeys : controlPlaneKeys))
    })
    authority = createServer((request, response) => {
      let raw = ""
      request.on("data", (chunk) => { raw += chunk })
      request.on("end", () => {
        const body = JSON.parse(raw) as { action?: string }
        const jti = String(decodeJwt(request.headers.authorization?.slice("Bearer ".length) ?? "").jti)
        response.setHeader("content-type", "application/json")
        if (body.action === "host_read") hostReads.push(jti)
        if (revoked.has(jti)) {
          response.statusCode = 401
          response.end(JSON.stringify({ error: { code: "runtime_access_token_revoked", message: "Runtime Access Token has been revoked" } }))
          return
        }
        response.end(JSON.stringify(body.action === "host_read" ? { lease: "workspace-lease", expiresAt: Date.now() + 60_000 } : {}))
      })
    })
    const keysUrl = await listen(keys)
    const sessionAuthorityUrl = `${await listen(authority)}/api/runtime-authority/session-authorize`
    root = await fs.mkdtemp(path.join(os.tmpdir(), "host-serving-direct-"))
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    installHostProviderConfigAuthority()
    runtime = await createHostRuntimeListener({ hostname: "127.0.0.1", port: 0, drainTimeoutMs: 2_000 })
    for (const workspaceId of [WS_A, WS_B]) {
      const directory = path.join(root, workspaceId)
      await fs.mkdir(directory, { recursive: true })
      await runtime.ensure({
        workspaceId,
        directory,
        hostId: HOST_ID,
        relay: { jwksUrl: `${keysUrl}/relay/jwks.json` },
        sessionAuthorityUrl,
        runtimeAccessJwksUrl: `${keysUrl}/.well-known/jwks.json`,
        storeRoot: path.join(root, "state", workspaceId),
      })
    }
    identity = await directTlsIdentity(await createDirectTlsKey())
    direct = startDirectListener({ identity, runtime, addresses: () => ["127.0.0.1"] })
    const routes = await direct.routes()
    if (!routes) throw new Error("the direct listener bound nothing")
    port = routes.port
  })

  afterAll(async () => {
    setHostProviderConfig(null)
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
    await direct?.close()
    await runtime?.close()
    await Pty.dispose()
    ClaxedoDB.close()
    await new Promise<void>((resolve) => keys?.close(() => resolve()))
    await new Promise<void>((resolve) => authority?.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  })

  function ownerToken(input: { workspaceId?: string; hostId?: string; jti?: string; signer?: CryptoKey } = {}) {
    return mintRuntimeAccessToken({
      principalKind: "user",
      actorId: "user_1",
      actorKind: "human",
      actorPublicId: "public_1",
      actorName: "Owner",
      orgId: "org_1",
      workspaceId: input.workspaceId ?? WS_A,
      hostId: input.hostId ?? HOST_ID,
      role: "owner",
      jti: input.jti ?? crypto.randomUUID(),
    }, input.signer ?? controlPlaneKey.privateKey, "EdDSA")
  }

  function call(target: string, headers: Record<string, string> = {}): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const request = httpsRequest({ host: "127.0.0.1", port, path: target, headers, ca: identity.certPem, checkServerIdentity: () => undefined }, (response) => {
        let raw = ""
        response.on("data", (chunk) => { raw += chunk })
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }))
      })
      request.on("error", reject)
      request.end()
    })
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const code = (answer: Answer) => (answer.body.error as { code?: string } | undefined)?.code

  test("serves the owner's token for this workspace and host over TLS, and asks the control plane once per token", async () => {
    const token = await ownerToken({ jti: "jti-valid" })

    const first = await call(`/workspaces/${WS_A}/session`, bearer(token))
    const second = await call(`/workspaces/${WS_A}/session`, bearer(token))

    expect(first).toEqual({ status: 200, body: [] })
    expect(second.status).toBe(200)
    expect(hostReads.filter((jti) => jti === "jti-valid")).toEqual(["jti-valid"])
  })

  test("refuses a request with no token, or a bearer that is not a Runtime Access Token, before any runtime", async () => {
    const relayToken = await mintRelayHostToken({
      principalKind: "user", actorId: "user_1", actorKind: "human", orgId: "org_1", workspaceId: WS_A, hostId: HOST_ID,
      role: "owner", parentJti: "jti-parent", backing: "local-worktree", kid: "relay",
    }, relayKey.privateKey, "EdDSA")

    expect(code(await call(`/workspaces/${WS_A}/session`))).toBe("direct_route_token_required")
    expect(code(await call(`/workspaces/${WS_A}/session`, bearer("not-a-token")))).toBe("direct_route_token_required")
    const replayed = await call(`/workspaces/${WS_A}/session`, { ...bearer(relayToken), "x-forwarded-by": "workspace-relay", "x-workspace-id": WS_A })
    expect(replayed.status).toBe(401)
    expect(code(replayed)).toBe("direct_route_token_required")
  })

  test("refuses a bad, revoked, other-workspace and other-host token", async () => {
    const stranger = await generateKeyPair("EdDSA", { extractable: true })
    revoked.add("jti-revoked")

    const bad = await call(`/workspaces/${WS_A}/session`, bearer(await ownerToken({ signer: stranger.privateKey })))
    const gone = await call(`/workspaces/${WS_A}/session`, bearer(await ownerToken({ jti: "jti-revoked" })))
    const otherWorkspace = await call(`/workspaces/${WS_A}/session`, bearer(await ownerToken({ workspaceId: WS_B })))
    const otherHost = await call(`/workspaces/${WS_A}/session`, bearer(await ownerToken({ hostId: "host_other" })))

    expect([bad.status, code(bad)]).toEqual([401, "invalid_relay_token"])
    expect([gone.status, code(gone)]).toEqual([401, "runtime_access_token_revoked"])
    expect([otherWorkspace.status, code(otherWorkspace)]).toEqual([403, "relay_token_workspace_mismatch"])
    expect([otherHost.status, code(otherHost)]).toEqual([403, "relay_token_host_mismatch"])
  })

  test("reaches only what the relay tunnel reaches", async () => {
    const token = await ownerToken()

    expect((await call(`/workspaces/${WS_A}/api/claxedo/host-serving`, bearer(token))).status).toBe(404)
    expect((await call(`/workspaces/${WS_A}/../../session`, bearer(token))).status).toBe(404)
    expect((await call(`/global/health`, bearer(token))).status).toBe(404)
    expect((await call(`/workspaces/33333333-3333-4333-8333-333333333333/session`, bearer(token))).status).toBe(404)
  })

  test("carries a WebSocket upgrade to the runtime under the same admission", async () => {
    const token = await ownerToken()
    const upgrade = (headers: string) => new Promise<string>((resolve, reject) => {
      const socket = tlsConnect({ host: "127.0.0.1", port, ca: identity.certPem, checkServerIdentity: () => undefined }, () => {
        socket.write(
          `GET /workspaces/${WS_A}/api/wr/pty/pty_missing/connect HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
          + `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${headers}\r\n`,
        )
      })
      let head = ""
      socket.on("data", (chunk: Buffer) => {
        head += chunk.toString()
        if (head.includes("\r\n")) {
          socket.destroy()
          resolve(head.split("\r\n")[0] ?? "")
        }
      })
      socket.on("error", reject)
    })

    expect(await upgrade("")).toBe("HTTP/1.1 401 Unauthorized")
    expect(await upgrade(`Sec-WebSocket-Protocol: claxedo-rat.${await ownerToken({ signer: (await generateKeyPair("EdDSA")).privateKey })}\r\n`)).toBe("HTTP/1.1 401 Unauthorized")
    expect(await upgrade(`Authorization: Bearer ${token}\r\n`)).toBe("HTTP/1.1 404 Not Found")
    expect(await upgrade(`Sec-WebSocket-Protocol: claxedo-rat.${token}\r\n`)).toBe("HTTP/1.1 404 Not Found")
  })

  test("while the owner has the machine paused, refuses every request and closes the terminals it carried, and serves again on resume", async () => {
    const token = await ownerToken()
    const created = await new Promise<{ id: string }>((resolve, reject) => {
      const body = JSON.stringify({ title: "paused", createRequestId: crypto.randomUUID() })
      const request = httpsRequest({
        host: "127.0.0.1", port, path: `/workspaces/${WS_A}/api/wr/pty`, method: "POST", ca: identity.certPem, checkServerIdentity: () => undefined,
        headers: { ...bearer(token), "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
      }, (response) => {
        let raw = ""
        response.on("data", (chunk) => { raw += chunk })
        response.on("end", () => resolve(JSON.parse(raw) as { id: string }))
      })
      request.on("error", reject)
      request.end(body)
    })
    const carried = tlsConnect({ host: "127.0.0.1", port, ca: identity.certPem, checkServerIdentity: () => undefined })
    const switched = new Promise<string>((resolve) => carried.once("data", (chunk: Buffer) => resolve(chunk.toString().split("\r\n")[0] ?? "")))
    const closed = new Promise<void>((resolve) => carried.once("close", () => resolve()))
    carried.on("error", () => undefined)
    carried.write(
      `GET /workspaces/${WS_A}/api/wr/pty/${created.id}/connect HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
      + `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer ${token}\r\n\r\n`,
    )
    expect(await switched).toBe("HTTP/1.1 101 Switching Protocols")

    direct.withhold(true)
    await closed
    const paused = await call(`/workspaces/${WS_A}/session`, bearer(token))
    expect([paused.status, code(paused)]).toEqual([503, "machine_paused"])

    direct.withhold(false)
    expect((await call(`/workspaces/${WS_A}/session`, bearer(token))).status).toBe(200)
    const removed = await new Promise<number>((resolve, reject) => {
      const request = httpsRequest({
        host: "127.0.0.1", port, path: `/workspaces/${WS_A}/api/wr/pty/${created.id}`, method: "DELETE", headers: bearer(token),
        ca: identity.certPem, checkServerIdentity: () => undefined,
      }, (response) => {
        response.resume()
        response.on("end", () => resolve(response.statusCode ?? 0))
      })
      request.on("error", reject)
      request.end()
    })
    expect(removed, "the terminal the test opened is closed through the same route").toBeLessThan(300)
  })
})

describe("the addresses and port the direct listener holds", () => {
  test("serves RFC 1918, CGNAT and unique-local interface addresses, never loopback or link-local", () => {
    const entry = (address: string, internal = false) => ({ address, internal }) as ReturnType<typeof os.networkInterfaces>[string] extends (infer E)[] | undefined ? E : never

    expect(privateNetworkAddresses({
      lo: [entry("127.0.0.1", true), entry("::1", true)],
      eth0: [entry("192.168.1.20"), entry("fe80::1"), entry("203.0.113.9")],
      tailscale0: [entry("100.101.102.103"), entry("fd7a:115c:a1e0::1")],
    })).toEqual(["100.101.102.103", "192.168.1.20", "fd7a:115c:a1e0::1"])
  })

  test("keeps its port as addresses come and go, replaces a port that is taken, and reports nothing with no address", async () => {
    const identity = await directTlsIdentity(await createDirectTlsKey())
    const runtime = { url: "http://127.0.0.1:1", fetch: async () => new Response(null), upgrade: () => undefined }
    const blocker = createServer()
    const taken = Number(new URL(await listen(blocker)).port)
    const reported: number[] = []
    let addresses = ["127.0.0.1"]
    const direct = startDirectListener({ identity, runtime, port: taken, onPort: (port) => reported.push(port), addresses: () => addresses })
    try {
      const first = await direct.routes()
      expect(first?.port).not.toBe(taken)
      expect(reported).toEqual([first?.port])
      expect(first).toEqual({ port: first?.port, addresses: ["127.0.0.1"], spkiSha256: identity.spkiSha256 })

      addresses = []
      expect(await direct.routes()).toBeUndefined()

      addresses = ["127.0.0.1"]
      expect(await direct.routes(), "an address that comes back is served on the port it had").toEqual({ port: first?.port, addresses: ["127.0.0.1"], spkiSha256: identity.spkiSha256 })
    } finally {
      await direct.close()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})
