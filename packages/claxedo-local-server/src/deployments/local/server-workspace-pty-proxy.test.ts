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

type AuthorityCall = { action: string; sessionId?: string; actorId?: string }

let dataDir: string
let previousDataDir: string | undefined
let server: LocalServer | undefined
let authority: Server | undefined
let proxyOnly: { port: number; close: () => Promise<void> } | undefined
let port: number
let origin: string
const authorityCalls: AuthorityCall[] = []
/** Actors the fake control plane admits to the session named in the request. */
let admitted = new Set<string>()

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
      const body = JSON.parse(raw || "{}") as { action?: string; sessionId?: string }
      const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1]
      const actor = bearer ? bearers.get(bearer) : undefined
      authorityCalls.push({
        action: String(body.action),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        ...(actor ? { actorId: actor.actorId } : {}),
      })
      const allowed = !!actor && admitted.has(actor.actorId)
      response.statusCode = allowed ? 200 : 403
      response.setHeader("content-type", "application/json")
      response.end(allowed
        ? JSON.stringify({ allowed: true, lease: "stream_lease", expiresAt: Date.now() + 60_000 })
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

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-pty-proxy-"))
  previousDataDir = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
  authorityCalls.length = 0
  admitted = new Set([OWNER.actorId])

  authority = fakeAuthority()
  setLocalHostEndpoints({ sessionAuthorityUrl: `${await listen(authority)}/api/runtime-authority/session-authorize` })

  port = await freePort()
  origin = `http://127.0.0.1:${port}`
  server = startLocalServer({ port, runtimeProxyOptions: relayActorOptions })
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
  const response = await fetch(`${origin}/api/workspace/resolve?directory=${encodeURIComponent(directory)}&create=true`)
  expect(response.status).toBe(200)
  return (await response.json() as { workspaceId: string }).workspaceId
}

/** A terminal the machine's own user started, bound to a session the relay can name. */
async function startTerminal(workspace: string, sessionId: string) {
  const response = await fetch(`${origin}/workspaces/${workspace}/api/wr/pty`, {
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

    const direct = await upgrade(`/api/wr/pty/${pty}/connect?workspaceId=${workspace}`)

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
