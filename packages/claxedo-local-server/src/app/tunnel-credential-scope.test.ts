import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { createNodeWebSocket } from "@hono/node-ws"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { stopHostServing } from "@claxedo/host-serving/serving"
import { setLocalHostEndpoints } from "../deployments/local/host-session-authority"
import { startLocalServer, type LocalServer } from "./start-local-server"
import { testDaemon } from "./test-support/daemon"

/**
 * What an org member holding a workspace grant reaches on this machine through
 * its host tunnel.
 *
 * Every request below arrives the way a real one does: the relay hands the
 * machine's own tunnel client an `http.request` frame, `serving.ts` decides
 * where it may land, and the machine replays it onto its real loopback
 * listener with the proxy headers stripped. Only the relay itself is a
 * stand-in — a WebSocket server speaking the tunnel protocol — because the
 * relay is the one hop that is not this machine's code.
 *
 * The claim under test is about the MACHINE: a workspace grant buys one
 * workspace, and must buy no part of the box that runs it — not its provider
 * accounts, not its project inventory, not another workspace of its own.
 */

/** `@claxedo/workspace-relay-protocol`'s `TUNNEL_PROTOCOL_VERSION`, which this package does not depend on. */
const TUNNEL_PROTOCOL = 1

type TunnelReply = { status: number; headers: Record<string, string>; body: string }

type RelayStandIn = {
  url: string
  /** Send one relayed request down the tunnel and read the host's whole answer. */
  request: (input: {
    workspaceId: string
    path: string
    method?: string
    token: string
    body?: unknown
  }) => Promise<TunnelReply>
  close: () => Promise<void>
}

type Grant = { workspaceId: string; role: "viewer" | "editor" }

let dataDir: string
let previousDataDir: string | undefined
let server: LocalServer | undefined
let identity: ReturnType<typeof testDaemon>
let origin: string
let relay: RelayStandIn | undefined
let authority: { url: string; close: () => Promise<void> } | undefined
/** Runtime Access Tokens the relay has minted, by the grant each one carries. */
let grants: Map<string, Grant>
let admittedWorkspaces: string[]

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

async function listening(node: Server) {
  const address = await new Promise<{ port: number }>((resolve, reject) => {
    const settle = () => {
      const bound = node.address()
      if (!bound || typeof bound === "string") {
        reject(new Error("the server did not bind a TCP port"))
        return
      }
      resolve(bound)
    }
    if (node.listening) {
      settle()
      return
    }
    node.once("listening", settle)
    node.once("error", reject)
  })
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(node: Server) {
  await new Promise<void>((resolve) => {
    node.closeAllConnections()
    node.close(() => resolve())
  })
}

/**
 * The control plane's session authority, admitting every read it is asked
 * about. The relayed arm of the daemon's session policy fails closed without
 * one, so a workspace read that this tunnel SHOULD serve would otherwise be
 * refused for a reason that has nothing to do with the tunnel's scope.
 */
async function startSessionAuthority() {
  const app = new Hono().post("/session-authorize", (c) => c.json({ allowed: true }))
  const node = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server
  const url = await listening(node)
  return { url: `${url}/session-authorize`, close: () => closeServer(node) }
}

/** The host's answer, as the tunnel writes it back across the relay socket. */
type ResponseFrame = {
  type: string
  request_id: string
  status?: number
  headers?: Record<string, string>
  body_base64?: string
}

async function startRelayStandIn(): Promise<RelayStandIn> {
  const app = new Hono()
  // `injectWebSocket` is declared with method syntax, so it is called through
  // the object; `upgradeWebSocket` is a plain property.
  const nodeWebSocket = createNodeWebSocket({ app })
  const { upgradeWebSocket } = nodeWebSocket
  const replies = new Map<string, {
    status?: number
    headers: Record<string, string>
    chunks: string[]
    settle: (reply: TunnelReply) => void
  }>()
  let host: { send: (data: string) => void } | undefined
  let announce: () => void
  const connected = new Promise<void>((resolve) => { announce = resolve })

  app.get("/host-tunnels/:hostId", upgradeWebSocket(() => ({
    onOpen: (_event, ws) => {
      host = { send: (data) => ws.send(data) }
      announce()
    },
    onMessage: (event) => {
      if (typeof event.data !== "string") return
      const frame = JSON.parse(event.data) as ResponseFrame
      const pending = replies.get(frame.request_id)
      if (!pending) return
      if (frame.type === "http.response.start") {
        pending.status = frame.status
        pending.headers = frame.headers ?? {}
        return
      }
      if (frame.type === "http.response.chunk" && frame.body_base64) {
        pending.chunks.push(frame.body_base64)
        return
      }
      if (frame.type === "http.response.end") {
        replies.delete(frame.request_id)
        pending.settle({
          status: pending.status ?? 0,
          headers: pending.headers,
          body: pending.chunks.map((chunk) => Buffer.from(chunk, "base64").toString("utf8")).join(""),
        })
      }
    },
  })))

  const node = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server
  nodeWebSocket.injectWebSocket(node)
  const url = await listening(node)

  return {
    url,
    request: async (input) => {
      await connected
      const requestId = randomUUID()
      const answer = new Promise<TunnelReply>((resolve, reject) => {
        const timer = setTimeout(() => {
          replies.delete(requestId)
          reject(new Error(`the host never answered ${input.method ?? "GET"} ${input.path}`))
        }, 15_000)
        replies.set(requestId, {
          headers: {},
          chunks: [],
          settle: (reply) => {
            clearTimeout(timer)
            resolve(reply)
          },
        })
      })
      const body = input.body === undefined ? undefined : JSON.stringify(input.body)
      host?.send(JSON.stringify({
        type: "http.request",
        protocol: TUNNEL_PROTOCOL,
        request_id: requestId,
        workspace_id: input.workspaceId,
        method: input.method ?? "GET",
        path: input.path,
        // What the relay's edge puts on a forwarded request: the caller's
        // Runtime Access Token, its own forwarding marker, and the client
        // identity headers the replay has to strip to reach a loopback gate.
        headers: {
          authorization: `Bearer ${input.token}`,
          "x-forwarded-by": "workspace-relay",
          "cf-connecting-ip": "203.0.113.7",
          origin: "https://app.claxedo.test",
          host: "relay.claxedo.test",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body_base64: Buffer.from(body).toString("base64") } : {}),
        end: true,
      }))
      return await answer
    },
    close: () => closeServer(node),
  }
}

async function registeredWorkspace(name: string) {
  const directory = path.join(dataDir, name)
  mkdirSync(directory)
  execFileSync("git", ["init", directory])
  const resolved = await identity.call(
    `${origin}/api/workspace/resolve?directory=${encodeURIComponent(directory)}&create=true`,
  )
  expect(resolved.status).toBe(200)
  return ((await resolved.json()) as { workspaceId: string }).workspaceId
}

/** Turn serving on the way Electron main does: the daemon's own canonical route. */
async function serveWorkspace(workspaceId: string) {
  const answer = await identity.call(`${origin}/api/claxedo/host-serving`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      credential: {
        hostId: "host_machine-1",
        enrollmentId: "enr_this_machine",
        relayUrl: relay!.url,
        hostTunnelToken: "host-tunnel-token",
        tokenExpiresAt: Date.now() + 300_000,
        jti: "jti-1",
        workspaceIds: [workspaceId],
      },
      endpoints: { sessionAuthorityUrl: authority!.url },
    }),
  })
  expect(answer.status).toBe(200)
}

function mintRelayToken(grant: Grant) {
  const token = `rht-${randomUUID()}`
  grants.set(token, grant)
  return token
}

/** The machine's provider accounts, read through the daemon's own credential route. */
async function machineCredentials() {
  const answer = await identity.call(`${origin}/api/claxedo/credentials`)
  expect(answer.status).toBe(200)
  return await answer.text()
}

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-tunnel-scope-"))
  previousDataDir = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
  grants = new Map()
  admittedWorkspaces = []
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  identity = testDaemon()
  server = startLocalServer({
    port,
    daemon: identity.daemon,
    runtimeProxyOptions: {
      // Stands in for `localHostRelayActor`'s signature check against the
      // relay's published key set. A Runtime Access Token is minted for ONE
      // workspace, so a token that names another places no actor here — the
      // same answer the claim check gives.
      resolveRelayActor: async (request, workspaceId) => {
        const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
        const grant = bearer ? grants.get(bearer) : undefined
        if (!grant || grant.workspaceId !== workspaceId) return undefined
        admittedWorkspaces.push(workspaceId)
        return {
          actorId: "usr_member",
          actorKind: "human" as const,
          actorPublicId: "member",
          actorName: "Member",
          orgId: "org_1",
          role: grant.role,
        }
      },
    },
  })
  await server.ready
  authority = await startSessionAuthority()
  relay = await startRelayStandIn()
})

afterEach(async () => {
  stopHostServing()
  setLocalHostEndpoints(undefined)
  await relay?.close()
  relay = undefined
  await authority?.close()
  authority = undefined
  await server?.stop()
  server = undefined
  ClaxedoDB.close()
  closeAuthorityDatabases()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

/**
 * Every provider-account mutation this machine answers at its own root, as a
 * relayed caller would have to ask for it.
 */
const CREDENTIAL_CALLS = [
  { method: "GET", path: "/provider/auth" },
  { method: "POST", path: "/provider/anthropic/oauth/authorize", body: { method: 0 } },
  { method: "POST", path: "/provider/anthropic/oauth/callback", body: { method: 0, code: "stolen-code" } },
  { method: "PUT", path: "/auth/anthropic", body: { type: "api", key: "sk-attacker" } },
  { method: "DELETE", path: "/auth/anthropic" },
  { method: "GET", path: "/config" },
  // The same families reached by climbing out of the workspace prefix the
  // tunnel is about to paste this path behind.
  { method: "GET", path: "/../../api/claxedo/credentials" },
  { method: "POST", path: "/../provider/anthropic/oauth/callback", body: { method: 0, code: "stolen-code" } },
] as const

describe.each(["viewer", "editor"] as const)("a workspace %s on this machine's tunnel", (role) => {
  test("cannot reach the machine's provider accounts, and none of it is written", async () => {
    const workspace = await registeredWorkspace("project-a")
    await serveWorkspace(workspace)
    const token = mintRelayToken({ workspaceId: workspace, role })
    const before = await machineCredentials()

    const answers = await Promise.all(CREDENTIAL_CALLS.map((call) =>
      relay!.request({ workspaceId: workspace, token, ...call })))

    expect(answers.map((answer) => answer.status)).toEqual(CREDENTIAL_CALLS.map(() => 403))
    // The tunnel's own refusal carries no body, where every refusal the daemon
    // writes carries an error envelope. This machine's listener never saw the
    // request, so no handler half-ran before the answer.
    expect(answers.map((answer) => answer.body)).toEqual(CREDENTIAL_CALLS.map(() => ""))
    expect(await machineCredentials()).toBe(before)
  })

  test("cannot read this machine's projects, or any workspace it was not granted", async () => {
    const granted = await registeredWorkspace("project-a")
    const other = await registeredWorkspace("project-b")
    await serveWorkspace(granted)
    const token = mintRelayToken({ workspaceId: granted, role })

    const inventory = await Promise.all([
      relay!.request({ workspaceId: granted, token, path: "/project" }),
      relay!.request({ workspaceId: granted, token, path: "/project/current" }),
      // The selector a caller controls, naming the workspace it was not given.
      relay!.request({ workspaceId: granted, token, path: `/project/current?directory=${other}` }),
      relay!.request({ workspaceId: granted, token, path: "/project/prj_1", method: "PATCH", body: { name: "taken" } }),
      // The relay strips `/workspaces/:id` before forwarding, so a path that
      // still names one is a caller trying to re-enter the family.
      relay!.request({ workspaceId: granted, token, path: `/workspaces/${other}/api/wr/health` }),
    ])
    // A frame naming another workspace on a connection registered for this
    // one: the tunnel answers for the workspace it opened, and no other.
    const foreign = await relay!.request({ workspaceId: other, token, path: "/api/wr/health" })

    expect(inventory.map((answer) => answer.status)).toEqual([403, 403, 403, 403, 403])
    expect(foreign.status).toBe(403)
  })

  test("still reads the workspace it was granted", async () => {
    const workspace = await registeredWorkspace("project-a")
    await serveWorkspace(workspace)
    const token = mintRelayToken({ workspaceId: workspace, role })

    const health = await relay!.request({ workspaceId: workspace, token, path: "/api/wr/health" })
    const capabilities = await relay!.request({ workspaceId: workspace, token, path: "/api/wr/capabilities" })
    const identityProbe = await relay!.request({ workspaceId: workspace, token, path: "/global/health" })
    const sessions = await relay!.request({ workspaceId: workspace, token, path: "/session" })

    expect([health.status, capabilities.status, identityProbe.status, sessions.status]).toEqual([200, 200, 200, 200])
    expect(JSON.parse(health.body)).toMatchObject({ service: "workspace-runtime" })
  })

  test("keeps traversing paths inside the granted workspace", async () => {
    const workspace = await registeredWorkspace("project-a")
    const other = await registeredWorkspace("project-b")
    await serveWorkspace(workspace)
    const token = mintRelayToken({ workspaceId: workspace, role })

    // Every replay must pass admission for the granted workspace, despite a
    // traversal attempt and a directory selector naming another workspace.
    for (const prefix of ["/../../", "/%2e%2e/%2e%2e/", "/a/../../../", "/..\\..\\"]) {
      admittedWorkspaces = []
      const reply = await relay!.request({ workspaceId: workspace, token, path: `${prefix}api/wr/health?directory=${other}` })
      expect(reply.status).toBe(200)
      expect(JSON.parse(reply.body)).toMatchObject({ service: "workspace-runtime" })
      expect(admittedWorkspaces).toContain(workspace)
      expect(admittedWorkspaces.every((id) => id === workspace)).toBe(true)
    }
  })
})

describe("the machine's own account management", () => {
  test("still runs over loopback for the application that owns this daemon", async () => {
    const workspace = await registeredWorkspace("project-a")
    await serveWorkspace(workspace)

    const methods = await identity.call(`${origin}/provider/auth`)
    const written = await identity.call(`${origin}/api/claxedo/credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_id: "anthropic", kind: "api_key", secret: "sk-the-owners-own" }),
    })
    const listed = await identity.call(`${origin}/api/claxedo/credentials`)

    expect(methods.status).toBe(200)
    expect(written.status).toBeLessThan(300)
    expect(listed.status).toBe(200)
    expect(await listed.text()).toContain("anthropic")
  })
})
