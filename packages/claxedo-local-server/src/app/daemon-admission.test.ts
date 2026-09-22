import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { connect } from "node:net"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { hostServingState, stopHostServing } from "@claxedo/host-serving/serving"
import { setLocalHostEndpoints } from "../deployments/local/host-session-authority"
import { startLocalServer, type LocalServer } from "./start-local-server"
import { DAEMON_CAPABILITY_HEADER } from "./daemon-admission"
import { testDaemon } from "./test-support/daemon"

/**
 * The daemon and a hostile page on the same machine.
 *
 * Everything here is one real listener, because the claim under test is about
 * what a caller can reach over a socket. The attacker is not remote: it is a
 * site the user's browser happens to have open on another loopback port, which
 * can make any request this listener answers and needs no more than that. The
 * controls it does NOT have to beat are stated as tests too — a loopback peer
 * address, an `Origin` the CORS policy would once have reflected, and the
 * daemon's own origin are none of them credentials.
 */

const HOSTILE_ORIGIN = "http://localhost:4173"

let dataDir: string
let previousDataDir: string | undefined
let server: LocalServer | undefined
let identity: ReturnType<typeof testDaemon>
let origin: string
/** Relay Host Tokens this fixture will place, standing in for the signature check. */
let relayTokens: Map<string, { actorId: string; actorPublicId: string; actorName: string }>

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

/** The relay's marks on a request the host tunnel replayed onto this listener. */
function relayed(token: string) {
  return { authorization: `Bearer ${token}`, "x-forwarded-by": "workspace-relay" }
}

function servingBody(workspaceIds: string[] = []) {
  return {
    credential: {
      hostId: "host_forged",
      enrollmentId: "enr_forged",
      relayUrl: "https://relay.attacker.test",
      hostTunnelToken: "attacker-tunnel-token",
      tokenExpiresAt: Date.now() + 300_000,
      jti: "jti_forged",
      workspaceIds,
    },
    endpoints: { sessionAuthorityUrl: "https://authority.attacker.test/api/runtime-authority/session-authorize" },
  }
}

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-daemon-admission-"))
  previousDataDir = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
  relayTokens = new Map([["member-token", { actorId: "usr_member", actorPublicId: "member", actorName: "Member" }]])
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  identity = testDaemon()
  server = startLocalServer({
    port,
    daemon: identity.daemon,
    runtimeProxyOptions: {
      // Stands in for `localHostRelayActor`'s signature check against the
      // relay's published key set: a token this host cannot place is no actor.
      resolveRelayActor: async (request) => {
        const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
        const actor = bearer ? relayTokens.get(bearer) : undefined
        if (!actor) return undefined
        return { ...actor, actorKind: "human" as const, orgId: "org_1", role: "editor" as const }
      },
    },
  })
  await server.ready
})

afterEach(async () => {
  stopHostServing()
  setLocalHostEndpoints(undefined)
  await server?.stop()
  server = undefined
  ClaxedoDB.close()
  closeAuthorityDatabases()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

/** A page on another loopback port: real socket, real Origin, no capability. */
function hostile(path: string, init: RequestInit = {}) {
  return fetch(`${origin}${path}`, {
    ...init,
    headers: { origin: HOSTILE_ORIGIN, ...Object.fromEntries(new Headers(init.headers)) },
  })
}

async function code(response: Response) {
  return ((await response.json()) as { error?: { code?: string } }).error?.code
}

async function registeredWorkspace() {
  const directory = path.join(dataDir, "project")
  mkdirSync(directory)
  execFileSync("git", ["init", directory])
  const resolved = await identity.call(
    `${origin}/api/workspace/resolve?directory=${encodeURIComponent(directory)}`,
    { method: "POST" },
  )
  expect(resolved.status).toBe(200)
  return ((await resolved.json()) as { workspaceId: string }).workspaceId
}

describe("a hostile page on this machine's loopback", () => {
  test("cannot read the machine's projects, files or configuration", async () => {
    const workspace = await registeredWorkspace()

    const answers = await Promise.all([
      hostile("/api/claxedo/projects"),
      hostile("/api/claxedo/session"),
      hostile(`/workspaces/${workspace}/api/wr/health`),
      hostile("/api/claxedo/agent-config"),
      hostile("/api/claxedo/credentials"),
      hostile("/api/claxedo/bootstrap"),
    ])

    expect(answers.map((answer) => answer.status)).toEqual([401, 401, 401, 401, 401, 401])
    expect(await code(answers[0])).toBe("daemon_capability_required")
  })

  test("cannot read the bootstrap's machine paths and project list, with or without a forged capability or bearer", async () => {
    const forged = await hostile("/api/claxedo/bootstrap", {
      headers: { [DAEMON_CAPABILITY_HEADER]: "not-the-token" },
    })
    // A bearer is not the capability: on a signed box the loopback branch used
    // to answer the rich local body to anything carrying one.
    const bearer = await hostile("/api/claxedo/bootstrap", {
      headers: { authorization: "Bearer spoofed" },
    })

    expect([forged.status, bearer.status]).toEqual([401, 401])
    expect(await code(bearer)).toBe("daemon_capability_required")
  })

  test("is refused a forged capability, and the daemon's own origin buys it nothing", async () => {
    const forged = await hostile("/api/claxedo/session", { headers: { [DAEMON_CAPABILITY_HEADER]: "not-the-token" } })
    // The header defense CORS provides is about reading answers. Claiming to BE
    // the daemon's own page is not an authorization, so a same-origin request
    // with no capability is refused exactly like the cross-origin one.
    const sameOrigin = await fetch(`${origin}/api/claxedo/session`, { headers: { origin } })

    expect([forged.status, sameOrigin.status]).toEqual([401, 401])
    expect(await code(forged)).toBe("daemon_capability_required")
    expect(await code(sameOrigin)).toBe("daemon_capability_required")
  })

  test("cannot repoint the machine's relay serving, and nothing is written before the refusal", async () => {
    const workspace = await registeredWorkspace()
    const before = hostServingState({ sessionAuthority: () => "local" })

    const forged = await hostile("/api/claxedo/host-serving", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(servingBody([workspace])),
    })

    expect(forged.status).toBe(401)
    expect(await code(forged)).toBe("daemon_capability_required")
    // The route's first act is `setLocalHostEndpoints`, so a gate that ran after
    // the handler would have changed who this machine verifies relayed callers
    // against even while answering 401.
    expect(hostServingState({ sessionAuthority: () => "local" })).toEqual(before)
  })

  test("is granted no CORS origin, so it could not read an answer even if one came back", async () => {
    const answer = await hostile("/api/claxedo/health")

    expect(answer.status).toBe(200)
    expect(answer.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("cannot open a socket to the daemon's event stream", async () => {
    const refused = await upgradeStatus("/api/cp/events", { origin: HOSTILE_ORIGIN })

    expect(refused).toBe(401)
  })
})

describe("the application that owns this daemon", () => {
  test("is admitted over HTTP and on a WebSocket handshake alike", async () => {
    const read = await identity.call(`${origin}/api/claxedo/session`)
    const socket = await upgradeStatus("/api/cp/events", identity.capability)

    expect(read.status).toBe(200)
    expect(socket).toBe(101)
  })

  test("reads the machine's own projects that the hostile page could not", async () => {
    await registeredWorkspace()

    const projects = await identity.call(`${origin}/api/claxedo/projects`)

    expect(projects.status).toBe(200)
  })

  test("reads the rich local bootstrap the hostile page was refused", async () => {
    const answer = await identity.call(`${origin}/api/claxedo/bootstrap`)

    expect(answer.status).toBe(200)
    const body = await answer.json() as { path?: { home?: string }; project?: unknown[] }
    expect(body.path?.home).toBeTruthy()
    expect(body.project).toBeDefined()
  })
})

describe("callers the capability is deliberately not minted for", () => {
  test("readiness probes stay public, and say nothing about the machine", async () => {
    const health = await fetch(`${origin}/api/claxedo/health`)
    const global = await fetch(`${origin}/global/health`)

    expect([health.status, global.status]).toEqual([200, 200])
    expect(await health.json()).toMatchObject({ ok: true })
  })

  test("the first-party MCP mount answers its own verifier, not the daemon gate", async () => {
    const answer = await fetch(`${origin}/api/claxedo/mcp?session=ses_1`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })

    // A harness child holds a runtime credential scoped to one workspace; minting
    // it the machine-wide capability instead would widen exactly what that
    // credential exists to bound.
    expect(answer.status).toBe(401)
    expect(await code(answer)).not.toBe("daemon_capability_required")
  })

  test("the egress broker answers its own runtime-token check", async () => {
    const answer = await fetch(`${origin}/bindings/b1/v1/messages`, { method: "POST" })

    expect(await code(answer)).not.toBe("daemon_capability_required")
  })
})

describe("a request the relay replayed onto this listener", () => {
  test("is admitted for the workspace its token places it on, with no capability", async () => {
    const workspace = await registeredWorkspace()

    const answer = await fetch(`${origin}/workspaces/${workspace}/api/wr/health`, {
      headers: relayed("member-token"),
    })

    expect(answer.status).toBe(200)
  })

  test("is refused in the ingress's own words when the relay never signed it", async () => {
    const workspace = await registeredWorkspace()

    const answer = await fetch(`${origin}/workspaces/${workspace}/api/wr/health`, {
      headers: relayed("token-the-relay-never-minted"),
    })

    expect(answer.status).toBe(403)
    expect(await code(answer)).toBe("relay_actor_unverified")
  })

  test("carries no authority off the dispatcher: the same marks reach no machine route", async () => {
    const serving = await fetch(`${origin}/api/claxedo/host-serving`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...relayed("member-token") },
      body: JSON.stringify(servingBody()),
    })
    const projects = await fetch(`${origin}/api/claxedo/projects`, { headers: relayed("member-token") })

    // The marker routes a request to the dispatcher that can verify it; it is
    // not an admission, and the families the dispatcher does not own never see
    // it as one.
    expect([serving.status, projects.status]).toEqual([401, 401])
    expect(await code(serving)).toBe("daemon_capability_required")
  })

  test("names no workspace, so the host aggregate stream stays the application's", async () => {
    const aggregate = await fetch(`${origin}/api/wr/events`, { headers: relayed("member-token") })

    expect(aggregate.status).toBe(401)
    expect(await code(aggregate)).toBe("daemon_capability_required")
  })
})

/**
 * The handshake's status line, from a socket written by hand.
 *
 * A refused upgrade never becomes a `WebSocket`, so the client object has no
 * status to report — the status line is the only place the answer exists, and
 * reading it means speaking the handshake directly.
 */
function upgradeStatus(target: string, headers: Record<string, string>) {
  const { hostname, port } = new URL(origin)
  return new Promise<number>((resolve, reject) => {
    let raw = ""
    const status = () => Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0)
    const socket = connect(Number(port), hostname, () => {
      socket.write([
        `GET ${target} HTTP/1.1`,
        `Host: ${hostname}:${port}`,
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
    socket.setTimeout(10_000, () => {
      socket.destroy()
      reject(new Error("the handshake did not settle"))
    })
  })
}
