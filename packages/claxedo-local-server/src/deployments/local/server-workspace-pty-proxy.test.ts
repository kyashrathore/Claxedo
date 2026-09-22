import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { createServer, type Server } from "node:http"
import { connect } from "node:net"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { createNodeWebSocket } from "@hono/node-ws"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { peerAddressStamp } from "@claxedo/server-core/platform/http/peer-address"
import { startLocalServer, type LocalServer } from "../../app/start-local-server"
import { testDaemon } from "../../app/test-support/daemon"
import type { RuntimeProxyOptions } from "../../workspace/runtime-dispatch/internals"
import { mountWorkspaceRuntimePtyWebSocketProxy } from "./server-workspace-pty-proxy"
import { setLocalHostEndpoints } from "./host-session-authority"

/**
 * Who may attach to a terminal on a machine that serves its own user and
 * relayed org members on one loopback listener.
 *
 * The terminal is the surface the session policy's prose is about — a reader
 * without a grant on the session must not see what the agent drove — and it is
 * the one surface that never reaches the runtime's own routes, because the
 * runtime's WebSocket upgrade is bound to a `@hono/node-ws` instance no
 * listener ever serves. So every case below is the same attach twice, once
 * with the relay's marks and once without, against a real listener and a real
 * terminal, with the control plane's verdicts faked because what is under test
 * is whether they are consulted at all.
 */

const OWNER = { actorId: "actor_owner", actorPublicId: "user_owner", actorName: "Owner" }
const MEMBER = { actorId: "actor_member", actorPublicId: "user_member", actorName: "Member" }

/** Which actor each bearer stands for; anything else is a token this host cannot verify. */
const bearers = new Map<string, typeof OWNER>([
  ["owner-token", OWNER],
  ["member-token", MEMBER],
])

type AuthorityCall = {
  action: string
  sessionId?: string
  actorId?: string
  stream?: true
  writeClass?: string
  lease?: string
}

let dataDir: string
let previousDataDir: string | undefined
let server: LocalServer | undefined
let identity: ReturnType<typeof testDaemon>
let authority: Server | undefined
let proxyOnly: { port: number; close: () => Promise<void> } | undefined
let port: number
let origin: string
const authorityCalls: AuthorityCall[] = []
/** Actors the fake control plane admits to the session named in the request. */
let admitted = new Set<string>()
/** Actors it admits for reading only — the share that buys eyes and no keyboard. */
let readOnly = new Set<string>()
/** How long a stream lease it hands out; the deadline an open socket is held to. */
let leaseMs = 60_000

const relayActorOptions: RuntimeProxyOptions = {
  // Stands in for the signature check `localHostRelayActor` does against the
  // relay's published key set: the token names the actor, and a token this
  // host cannot place is not an actor at all.
  resolveRelayActor: async (request) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
    const actor = bearer ? bearers.get(bearer) : undefined
    if (!actor) return undefined
    return {
      actorId: actor.actorId,
      actorKind: "human" as const,
      actorPublicId: actor.actorPublicId,
      actorName: actor.actorName,
      orgId: "org_1",
      role: "editor" as const,
    }
  },
}

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("could not allocate a port"))
        return
      }
      probe.close(() => resolve(address.port))
    })
    probe.on("error", reject)
  })
}

function listen(target: Server) {
  return new Promise<string>((resolve) => {
    target.listen(0, "127.0.0.1", () => {
      const address = target.address()
      if (!address || typeof address === "string") throw new Error("no port")
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

/**
 * The control plane's session authority, reduced to the rule this surface
 * depends on: a session is reachable by the actors it was shared to and by
 * nobody else.
 */
function fakeAuthority() {
  return createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => { raw += chunk })
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as {
        action?: string
        sessionId?: string
        stream?: true
        writeClass?: string
        lease?: string
      }
      const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1]
      const actor = bearer ? bearers.get(bearer) : undefined
      authorityCalls.push({
        action: String(body.action),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        ...(actor ? { actorId: actor.actorId } : {}),
        ...(body.stream ? { stream: true } : {}),
        ...(body.writeClass ? { writeClass: body.writeClass } : {}),
        ...(body.lease ? { lease: body.lease } : {}),
      })
      const allowed = !!actor
        && admitted.has(actor.actorId)
        && !(body.action === "write" && readOnly.has(actor.actorId))
      response.statusCode = allowed ? 200 : 403
      response.setHeader("content-type", "application/json")
      response.end(allowed
        ? JSON.stringify({ allowed: true, lease: "stream_lease", expiresAt: Date.now() + leaseMs })
        : JSON.stringify({ error: { code: "workspace_authorization_denied", message: "denied" } }))
    })
  })
}

/**
 * The composition `claxedo-server`'s self-hosted node builds: this proxy is
 * mounted BEFORE the `/workspaces/:workspaceId/*` relay route, so its
 * workspace-scoped terminal route is the one that answers.
 */
async function startPtyProxyOnly() {
  const app = new Hono()
  const nodeWebSocket = createNodeWebSocket({ app })
  app.use(peerAddressStamp())
  mountWorkspaceRuntimePtyWebSocketProxy(app, nodeWebSocket.upgradeWebSocket, {
    ...relayActorOptions,
    verifyRelayIngress: true,
  })
  const proxyPort = await freePort()
  const listener = serve({ fetch: (request, env) => app.fetch(request, env), port: proxyPort, hostname: "127.0.0.1" })
  await new Promise<void>((resolve) => { listener.once("listening", () => resolve()) })
  nodeWebSocket.injectWebSocket(listener)
  return {
    port: proxyPort,
    close: () => new Promise<void>((resolve) => { listener.close(() => resolve()) }),
  }
}

/** The relay's marks on a request it forwarded: its own bearer and its own marker. */
function relayed(token: string) {
  return { authorization: `Bearer ${token}`, "x-forwarded-by": "workspace-relay" }
}

/**
 * The handshake a browser sends, written by hand: a WebSocket upgrade cannot
 * carry an `Authorization` header through the platform `WebSocket`, and `ws`
 * does not resolve from this package.
 */
function upgrade(target: string, headers: Record<string, string> = {}, onPort = port) {
  return new Promise<number>((resolve, reject) => {
    let raw = ""
    const status = () => Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0)
    const socket = connect(onPort, "127.0.0.1", () => {
      socket.write([
        `GET ${target} HTTP/1.1`,
        `Host: 127.0.0.1:${onPort}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==",
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ].join("\r\n"))
    })
    socket.on("data", (chunk: Buffer) => {
      raw += chunk.toString("latin1")
      if (!raw.includes("\r\n\r\n")) return
      socket.destroy()
      resolve(status())
    })
    socket.on("close", () => resolve(status()))
    socket.on("error", reject)
    socket.setTimeout(15_000, () => {
      socket.destroy()
      reject(new Error("terminal upgrade timed out"))
    })
  })
}

/**
 * A terminal client, written by hand for the same reason the handshake above
 * is: the platform `WebSocket` cannot carry the relay's `Authorization` header
 * and `ws` does not resolve from this package. It speaks only what a terminal
 * needs — masked text frames out, whatever arrives in — so the tests below can
 * type at a real shell and read what it answers.
 */
type TerminalSocket = {
  send: (text: string) => void
  output: () => string
  closeCode: () => number | undefined
  open: () => boolean
  until: (predicate: () => boolean, timeoutMs?: number) => Promise<boolean>
  end: () => void
}

function terminalSocket(target: string, headers: Record<string, string> = {}, onPort = port) {
  return new Promise<TerminalSocket>((resolve, reject) => {
    let handshake = ""
    let upgraded = false
    let received = ""
    let closeCode: number | undefined
    let ended = false
    let buffer = Buffer.alloc(0)
    const socket = connect(onPort, "127.0.0.1", () => {
      socket.write([
        `GET ${target} HTTP/1.1`,
        `Host: 127.0.0.1:${onPort}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==",
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ].join("\r\n"))
    })

    const frames = () => {
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f
        const masked = (buffer[1] & 0x80) !== 0
        let length = buffer[1] & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        if (masked) offset += 4
        if (buffer.length < offset + length) return
        const payload = buffer.subarray(offset, offset + length)
        buffer = buffer.subarray(offset + length)
        if (opcode === 0x1) received += payload.toString("utf8")
        // A binary frame is either the runtime's cursor/checkpoint envelope
        // (a leading zero byte) or terminal bytes; both are read as text here.
        if (opcode === 0x2) received += payload.subarray(payload[0] === 0 ? 1 : 0).toString("utf8")
        if (opcode === 0x8) {
          closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
          ended = true
          socket.destroy()
          return
        }
      }
    }

    socket.on("data", (chunk: Buffer) => {
      if (!upgraded) {
        handshake += chunk.toString("latin1")
        const end = handshake.indexOf("\r\n\r\n")
        if (end < 0) return
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(handshake)?.[1] ?? 0)
        if (status !== 101) {
          socket.destroy()
          reject(new Error(`terminal upgrade answered ${status}`))
          return
        }
        upgraded = true
        buffer = Buffer.from(handshake.slice(end + 4), "latin1")
        handshake = ""
        frames()
        resolve(client)
        return
      }
      buffer = Buffer.concat([buffer, chunk])
      frames()
    })
    socket.on("close", () => { ended = true })
    socket.on("error", (error) => {
      ended = true
      if (!upgraded) reject(error)
    })

    const client: TerminalSocket = {
      send(text) {
        const payload = Buffer.from(text, "utf8")
        const mask = Buffer.from([1, 2, 3, 4])
        const header = payload.length < 126
          ? Buffer.from([0x81, 0x80 | payload.length])
          : Buffer.concat([Buffer.from([0x81, 0xfe]), (() => {
              const size = Buffer.alloc(2)
              size.writeUInt16BE(payload.length)
              return size
            })()])
        socket.write(Buffer.concat([
          header,
          mask,
          Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4])),
        ]))
      },
      output: () => received,
      closeCode: () => closeCode,
      open: () => upgraded && !ended,
      async until(predicate, timeoutMs = 5_000) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          if (predicate()) return true
          await new Promise((wait) => setTimeout(wait, 25))
        }
        return predicate()
      },
      end() {
        ended = true
        socket.destroy()
      },
    }
  })
}

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-pty-proxy-"))
  previousDataDir = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
  authorityCalls.length = 0
  admitted = new Set([OWNER.actorId])
  readOnly = new Set()
  leaseMs = 60_000

  authority = fakeAuthority()
  setLocalHostEndpoints({ sessionAuthorityUrl: `${await listen(authority)}/api/runtime-authority/session-authorize` })

  port = await freePort()
  origin = `http://127.0.0.1:${port}`
  identity = testDaemon()
  server = startLocalServer({ port, daemon: identity.daemon, runtimeProxyOptions: relayActorOptions })
  await server.ready
  proxyOnly = await startPtyProxyOnly()
})

afterEach(async () => {
  await proxyOnly?.close()
  proxyOnly = undefined
  await server?.stop()
  server = undefined
  setLocalHostEndpoints(undefined)
  await new Promise<void>((resolve) => {
    if (!authority) return resolve()
    authority.close(() => resolve())
  })
  authority = undefined
  ClaxedoDB.close()
  closeAuthorityDatabases()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

async function resolveWorkspace() {
  const directory = path.join(dataDir, "project")
  mkdirSync(directory)
  execFileSync("git", ["init", directory])
  const response = await identity.call(`${origin}/api/workspace/resolve?directory=${encodeURIComponent(directory)}`, { method: "POST" })
  expect(response.status).toBe(200)
  return (await response.json() as { workspaceId: string }).workspaceId
}

/** A terminal the machine's own user started, bound to a session the relay can name. */
async function startTerminal(workspace: string, sessionId: string) {
  const response = await identity.call(`${origin}/workspaces/${workspace}/api/wr/pty`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "/bin/sh", sessionId }),
  })
  expect(response.status).toBe(200)
  return (await response.json() as { id: string }).id
}

describe("attaching to an in-process terminal by workspace id", () => {
  test("a relayed member the authority does not place on the terminal's session is refused the upgrade", async () => {
    const workspace = await resolveWorkspace()
    const pty = await startTerminal(workspace, "ses_shared")
    const target = `/api/wr/pty/${pty}/connect?workspaceId=${workspace}`

    const member = await upgrade(target, relayed("member-token"))
    const owner = await upgrade(target, relayed("owner-token"))

    expect(member).toBe(403)
    expect(owner).toBe(101)
    expect(authorityCalls.map((call) => `${call.action}:${call.sessionId}:${call.actorId}`)).toEqual([
      `read:ses_shared:${MEMBER.actorId}`,
      `read:ses_shared:${OWNER.actorId}`,
    ])
  }, 60_000)

  test("the machine's own user attaches and no authority is asked", async () => {
    const workspace = await resolveWorkspace()
    const pty = await startTerminal(workspace, "ses_shared")

    const direct = await upgrade(`/api/wr/pty/${pty}/connect?workspaceId=${workspace}`, identity.capability)

    expect(direct).toBe(101)
    expect(authorityCalls).toEqual([])
  }, 60_000)

  test("a relayed bearer this host cannot verify is refused before the runtime is asked anything", async () => {
    const workspace = await resolveWorkspace()
    const pty = await startTerminal(workspace, "ses_shared")

    const forged = await upgrade(`/api/wr/pty/${pty}/connect?workspaceId=${workspace}`, relayed("not-a-real-token"))

    expect(forged).toBe(403)
    expect(authorityCalls).toEqual([])
  }, 60_000)
})

/**
 * What the socket does after it is open, which is the whole of P-82: an
 * admission is not a permission to type, and it is not a permission that lasts.
 * Every case below runs against the real listener, the real proxy and a real
 * `/bin/sh`.
 */
describe("what an attached terminal may do while it is attached", () => {
  const sockets: TerminalSocket[] = []

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.end()
  })

  async function attach(target: string, headers?: Record<string, string>) {
    const socket = await terminalSocket(target, headers)
    sockets.push(socket)
    return socket
  }

  test("a share that buys reading keeps its output and cannot type", async () => {
    const workspace = await resolveWorkspace()
    const pty = await startTerminal(workspace, "ses_shared")
    const target = `/api/wr/pty/${pty}/connect?workspaceId=${workspace}`
    admitted.add(MEMBER.actorId)
    readOnly.add(MEMBER.actorId)

    const reader = await attach(target, relayed("member-token"))
    const owner = await attach(target, relayed("owner-token"))
    expect(await owner.until(() => owner.output().includes("$") || owner.output().includes("#"))).toBe(true)

    reader.send("echo pwned\r")
    await new Promise((resolve) => setTimeout(resolve, 750))
    owner.send("echo alive\r")

    expect(await reader.until(() => reader.output().includes("alive"))).toBe(true)
    expect(reader.output()).not.toContain("pwned")
    expect(reader.open()).toBe(true)
    const memberCalls = authorityCalls.filter((call) => call.actorId === MEMBER.actorId)
    expect(memberCalls.some((call) => call.action === "write" && call.stream === true)).toBe(true)
    expect(memberCalls.every((call) => call.sessionId === "ses_shared")).toBe(true)
  }, 60_000)

  test("the owner types and the shell answers", async () => {
    const workspace = await resolveWorkspace()
    const pty = await startTerminal(workspace, "ses_shared")

    const owner = await attach(`/api/wr/pty/${pty}/connect?workspaceId=${workspace}`, relayed("owner-token"))
    owner.send("echo terminal-is-live\r")

    expect(await owner.until(() => /terminal-is-live\r?\n/.test(owner.output()))).toBe(true)
    expect(authorityCalls.map((call) => `${call.action}:${call.stream === true}`)).toEqual([
      "read:true",
      "write:true",
    ])
  }, 60_000)

  test("revoking a grant closes the socket it already holds, by the lease deadline", async () => {
    leaseMs = 2_000
    const workspace = await resolveWorkspace()
    const pty = await startTerminal(workspace, "ses_shared")

    const owner = await attach(`/api/wr/pty/${pty}/connect?workspaceId=${workspace}`, relayed("owner-token"))
    expect(await owner.until(() => owner.output().length > 0)).toBe(true)

    admitted.delete(OWNER.actorId)
    const closed = await owner.until(() => !owner.open(), leaseMs + 2_000)

    expect(closed).toBe(true)
    expect(owner.closeCode()).toBe(1008)
    expect(authorityCalls.some((call) => call.stream === true && call.lease === "stream_lease")).toBe(true)
  }, 60_000)

  test("the machine's own user reads and types with no authority asked", async () => {
    const workspace = await resolveWorkspace()
    const pty = await startTerminal(workspace, "ses_shared")

    const direct = await attach(`/api/wr/pty/${pty}/connect?workspaceId=${workspace}`, identity.capability)
    direct.send("echo local-owner\r")

    expect(await direct.until(() => /local-owner\r?\n/.test(direct.output()))).toBe(true)
    expect(authorityCalls).toEqual([])
  }, 60_000)

  test("a reattach asks the authority again and is refused once the grant is gone", async () => {
    const workspace = await resolveWorkspace()
    const pty = await startTerminal(workspace, "ses_shared")
    const target = `/api/wr/pty/${pty}/connect?workspaceId=${workspace}`

    const first = await attach(target, relayed("owner-token"))
    expect(await first.until(() => first.output().length > 0)).toBe(true)
    first.end()

    admitted.delete(OWNER.actorId)
    await expect(terminalSocket(target, relayed("owner-token"))).rejects.toThrow("answered 403")
  }, 60_000)
})

describe("attaching over the relay-shaped workspace path", () => {
  test("a relayed member without a grant is refused; the owner and the machine's own user attach", async () => {
    const workspace = await resolveWorkspace()
    const pty = await startTerminal(workspace, "ses_shared")
    const target = `/workspaces/${workspace}/api/wr/pty/${pty}/connect`

    const member = await upgrade(target, relayed("member-token"), proxyOnly!.port)
    const owner = await upgrade(target, relayed("owner-token"), proxyOnly!.port)
    const direct = await upgrade(target, {}, proxyOnly!.port)

    expect(member).toBe(403)
    expect(owner).toBe(101)
    expect(direct).toBe(101)
    expect(authorityCalls.map((call) => `${call.action}:${call.actorId}`)).toEqual([
      `read:${MEMBER.actorId}`,
      `read:${OWNER.actorId}`,
    ])
  }, 60_000)
})
