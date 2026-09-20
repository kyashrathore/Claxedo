import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { startLocalServer, type LocalServer } from "./start-local-server"
import { setLocalHostEndpoints } from "../deployments/local/host-session-authority"

/**
 * The privacy question a serving desktop answers, asked of the real daemon.
 *
 * A machine that publishes its workspaces is reached two ways at once: its own
 * user at the keyboard, and any org member the control plane lets through the
 * relay. The relay REPLAYS a member's request onto this machine's loopback
 * listener with the proxy headers stripped, so the two are indistinguishable
 * by address — a daemon that answered both as the owner would hand every
 * session on the box to the whole org.
 *
 * So every case below is the same request twice, once with the relay's marks
 * and once without, against `startLocalServer` with its real routes, its real
 * embedded runtimes and the real policy the composition mounts. The two
 * loopback services the control plane would provide are faked here — the
 * session authority's verdicts and the verification of the relay's bearer —
 * because what is under test is which of them the daemon consults, and when.
 */

const OWNER = { actorId: "actor_owner", actorPublicId: "user_owner", actorName: "Owner" }
const MEMBER = { actorId: "actor_member", actorPublicId: "user_member", actorName: "Member" }

type AuthorityCall = { action: string; writeClass?: string; sessionId?: string; actorId?: string }

let dataDir: string
let previousDataDir: string | undefined
let server: LocalServer | undefined
let authority: Server | undefined
let authorityUrl: string
let workspaceId: string
let origin: string

/** Which actor each bearer stands for; anything else is a token this host cannot verify. */
const bearers = new Map<string, typeof OWNER>([
  ["owner-token", OWNER],
  ["member-token", MEMBER],
])

const authorityCalls: AuthorityCall[] = []
/** Actors the fake control plane admits to the session named in the request. */
let admitted = new Set<string>()
/**
 * Actors admitted through a SHARE, and at what level. An actor admitted by
 * their own standing — creator, participant, org administrator — has no entry,
 * because the level narrows the share and not the person.
 */
let shareLevels = new Map<string, "follow" | "send">()

/** `startLocalServer` reports the port it was GIVEN, so the port is chosen here. */
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

function listen(server: Server) {
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("no port")
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

/**
 * The control plane's `/api/runtime-authority/session-authorize`, reduced to
 * the one rule this file depends on: a session is reachable by the actors it
 * was registered or shared to, and by nobody else. Its refusal is the 403 the
 * real adapters raise for a session the caller has no row for — which is the
 * same answer they give for a session that does not exist at all.
 */
function fakeAuthority() {
  return createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => { raw += chunk })
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as { action?: string; writeClass?: string; sessionId?: string }
      const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1]
      const actor = bearer ? bearers.get(bearer) : undefined
      authorityCalls.push({
        action: String(body.action),
        ...(body.writeClass ? { writeClass: body.writeClass } : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        ...(actor ? { actorId: actor.actorId } : {}),
      })
      // Both adapters refuse a `follow` grantee's write, and any grantee's
      // `session_control` write, with the same 403 they raise for a session
      // the caller has no row for at all. A turn action carries no class and
      // is the turn itself.
      const writing = body.action === "write" || String(body.action).startsWith("turn_")
      const shared = actor ? shareLevels.get(actor.actorId) : undefined
      const refusedShare = shared === "follow" || (!!shared && body.writeClass === "session_control")
      const allowed = !!actor && admitted.has(actor.actorId) && !(writing && refusedShare)
      response.statusCode = allowed ? 200 : 403
      response.setHeader("content-type", "application/json")
      if (!allowed) {
        response.end(JSON.stringify({ error: { code: "workspace_authorization_denied", message: "denied" } }))
        return
      }
      if (body.action === "turn_acquire") {
        response.end(JSON.stringify({
          allowed: true,
          turnId: "turn_1",
          leaseId: "lease_1",
          fencingToken: 1,
          acquiredAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }))
        return
      }
      response.end(JSON.stringify({ allowed: true, lease: "stream_lease", expiresAt: Date.now() + 60_000 }))
    })
  })
}

/** The relay's marks on a request it forwarded: its own bearer and its own marker. */
function relayed(token: string) {
  return { authorization: `Bearer ${token}`, "x-forwarded-by": "workspace-relay" }
}

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-desktop-authority-"))
  previousDataDir = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
  authorityCalls.length = 0
  admitted = new Set([OWNER.actorId])
  shareLevels = new Map()

  authority = fakeAuthority()
  authorityUrl = `${await listen(authority)}/api/runtime-authority/session-authorize`
  setLocalHostEndpoints({ sessionAuthorityUrl: authorityUrl })

  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  server = startLocalServer({
    port,
    runtimeProxyOptions: {
      // Stands in for the signature check `localHostRelayActor` does against
      // the relay's published key set: the token names the actor, and a token
      // this host cannot place is not an actor at all.
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
    },
  })
  await server.ready
})

afterEach(async () => {
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
  const response = await fetch(
    `${origin}/api/workspace/resolve?directory=${encodeURIComponent(directory)}&create=true`,
  )
  expect(response.status).toBe(200)
  const body = await response.json() as { workspaceId: string }
  workspaceId = body.workspaceId
  return workspaceId
}

/** Reads only the status line of a stream and hangs up; an SSE body never ends. */
async function status(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController()
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    const code = response.status
    const body = code === 200 ? undefined : await response.json() as { error?: { code?: string } }
    return { code, error: body?.error?.code }
  } finally {
    controller.abort()
  }
}

describe("a serving desktop answers a relayed caller privately and its own user directly", () => {
  test("a relayed member is refused a session the authority does not place them on; the same read over loopback is the runtime's own 404", async () => {
    const workspace = await resolveWorkspace()
    const url = `${origin}/workspaces/${workspace}/session/ses_does_not_exist`

    const relayedRead = await status(url, relayed("member-token"))
    const directRead = await status(url)

    expect(relayedRead.code).toBe(403)
    expect(relayedRead.error).toBe("workspace_authorization_denied")
    expect(directRead.code).toBe(404)
    expect(directRead.error).toBe("session_not_found")
    // The machine's own user is never an authority question.
    expect(authorityCalls.filter((call) => call.actorId === undefined)).toEqual([])
    expect(authorityCalls.map((call) => call.actorId)).toEqual([MEMBER.actorId])
  })

  test("the owner reaches the same session the member cannot", async () => {
    const workspace = await resolveWorkspace()
    const url = `${origin}/workspaces/${workspace}/session/ses_private`

    const member = await status(url, relayed("member-token"))
    // Past the authority, the runtime answers for a session it does not hold.
    const owner = await status(url, relayed("owner-token"))

    expect(member.code).toBe(403)
    expect(owner.code).toBe(404)
    expect(authorityCalls.map((call) => `${call.action}:${call.actorId}`))
      .toEqual([`read:${MEMBER.actorId}`, `read:${OWNER.actorId}`])
  })

  test("a relayed request whose bearer this host cannot verify is refused at the ingress, not read as local", async () => {
    const workspace = await resolveWorkspace()

    const forged = await status(`${origin}/workspaces/${workspace}/session/ses_x`, relayed("not-a-real-token"))

    expect(forged.code).toBe(403)
    expect(forged.error).toBe("relay_actor_unverified")
    // Refused before the policy, so the control plane was never asked.
    expect(authorityCalls).toEqual([])
  })

  test("a relayed create needs a reservation; the machine's own user creates with none", async () => {
    const workspace = await resolveWorkspace()
    const create = (headers: Record<string, string>) => fetch(`${origin}/workspaces/${workspace}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({}),
    })

    const relayedCreate = await create(relayed("owner-token"))

    expect(relayedCreate.status).toBe(400)
    expect(await relayedCreate.json()).toMatchObject({ error: { code: "session_reservation_required" } })
    // The direct create is refused by the missing harness, never by a
    // reservation it was not asked for.
    const directCreate = await create({})
    expect(directCreate.status).not.toBe(400)
  })

  test("a relayed prompt is authorized as its actor; a prompt from the machine's own user asks nobody", async () => {
    const workspace = await resolveWorkspace()
    const prompt = (headers: Record<string, string>) => fetch(`${origin}/workspaces/${workspace}/session/ses_turn/message`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ messageID: "msg_1", parts: [{ type: "text", text: "hi" }] }),
    })

    const refused = await prompt(relayed("member-token"))
    expect(refused.status).toBe(403)
    expect(authorityCalls.map((call) => `${call.action}:${call.actorId}`)).toEqual([`write:${MEMBER.actorId}`])

    authorityCalls.length = 0
    // The owner passes the authority and is then refused by the unconfigured
    // harness, which is what this fixture has instead of an agent.
    await prompt(relayed("owner-token"))
    expect(authorityCalls.map((call) => `${call.action}:${call.actorId}`)).toEqual([`write:${OWNER.actorId}`])

    authorityCalls.length = 0
    await prompt({})
    expect(authorityCalls).toEqual([])
  })
})

describe("the workspace event stream", () => {
  test("a relayed member the authority refuses at workspace level is told to reopen for one session", async () => {
    const workspace = await resolveWorkspace()

    const refused = await status(`${origin}/workspaces/${workspace}/api/wr/events`, relayed("member-token"))

    expect(refused.code).toBe(403)
    expect(refused.error).toBe("workspace_event_stream_denied")
  })

  test("the session-scoped arm serves a session the authority grants and refuses one it does not", async () => {
    const workspace = await resolveWorkspace()
    const scoped = (token: string) =>
      status(`${origin}/workspaces/${workspace}/api/wr/events?sessionID=ses_shared`, relayed(token))

    const granted = await scoped("owner-token")
    const denied = await scoped("member-token")

    expect(granted.code).toBe(200)
    expect(denied.code).toBe(403)
    expect(denied.error).toBe("session_event_stream_denied")
  })

  test("the machine's own user reads both the workspace stream and the host aggregate without an authority", async () => {
    const workspace = await resolveWorkspace()

    const workspaceStream = await status(`${origin}/workspaces/${workspace}/api/wr/events`)
    const aggregate = await status(`${origin}/api/wr/events`)

    expect(workspaceStream.code).toBe(200)
    expect(aggregate.code).toBe(200)
    expect(authorityCalls).toEqual([])
  })
})

describe("a share level decides what a relayed grantee may do", () => {
  test("a follow grantee reads the session and streams it; the same grantee's prompt is refused", async () => {
    const workspace = await resolveWorkspace()
    admitted = new Set([OWNER.actorId, MEMBER.actorId])
    shareLevels = new Map([[MEMBER.actorId, "follow"]])

    const read = await status(`${origin}/workspaces/${workspace}/session/ses_shared`, relayed("member-token"))
    const stream = await status(
      `${origin}/workspaces/${workspace}/api/wr/events?sessionID=ses_shared`,
      relayed("member-token"),
    )
    const prompt = await fetch(`${origin}/workspaces/${workspace}/session/ses_shared/message`, {
      method: "POST",
      headers: { "content-type": "application/json", ...relayed("member-token") },
      body: JSON.stringify({ messageID: "msg_1", parts: [{ type: "text", text: "hi" }] }),
    })

    // Past the authority, the runtime answers for a session it does not hold.
    expect(read.code).toBe(404)
    expect(stream.code).toBe(200)
    expect(prompt.status).toBe(403)
    expect(await prompt.json()).toMatchObject({ error: { code: "workspace_authorization_denied" } })
    expect(authorityCalls.map((call) => `${call.action}:${call.actorId}`))
      .toEqual([`read:${MEMBER.actorId}`, `read:${MEMBER.actorId}`, `write:${MEMBER.actorId}`])
  })

  test("a send grantee is refused the shell, the permission mode and the delete, and the authority is asked for control", async () => {
    const workspace = await resolveWorkspace()
    admitted = new Set([OWNER.actorId, MEMBER.actorId])
    shareLevels = new Map([[MEMBER.actorId, "send"]])

    const shell = await fetch(`${origin}/workspaces/${workspace}/session/ses_shared/shell`, {
      method: "POST",
      headers: { "content-type": "application/json", ...relayed("member-token") },
      body: JSON.stringify({ command: "id" }),
    })
    const permissionMode = await fetch(`${origin}/workspaces/${workspace}/session/ses_shared/permission-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...relayed("member-token") },
      body: JSON.stringify({ modeId: "yolo" }),
    })
    const deleted = await fetch(`${origin}/workspaces/${workspace}/session/ses_shared`, {
      method: "DELETE",
      headers: relayed("member-token"),
    })

    expect([shell.status, permissionMode.status, deleted.status]).toEqual([403, 403, 403])
    expect(await shell.json()).toMatchObject({ error: { code: "workspace_authorization_denied" } })
    expect(authorityCalls.map((call) => `${call.action}/${call.writeClass}:${call.actorId}`)).toEqual([
      `write/session_control:${MEMBER.actorId}`,
      `write/session_control:${MEMBER.actorId}`,
      `write/session_control:${MEMBER.actorId}`,
    ])
  })

  test("the same grantee at send is admitted to the prompt and reaches the harness", async () => {
    const workspace = await resolveWorkspace()
    admitted = new Set([OWNER.actorId, MEMBER.actorId])
    shareLevels = new Map([[MEMBER.actorId, "send"]])

    const prompt = await fetch(`${origin}/workspaces/${workspace}/session/ses_shared/message`, {
      method: "POST",
      headers: { "content-type": "application/json", ...relayed("member-token") },
      body: JSON.stringify({ messageID: "msg_1", parts: [{ type: "text", text: "hi" }] }),
    })

    // Admitted, then refused by the unconfigured harness this fixture has
    // instead of an agent — which is as far past admission as it can get here.
    expect(prompt.status).not.toBe(403)
    expect(authorityCalls.map((call) => `${call.action}/${call.writeClass}:${call.actorId}`))
      .toEqual([`write/agent_turn:${MEMBER.actorId}`])
  })
})

describe("the composition's own relay actor", () => {
  /**
   * A relay-minted token in shape only: enough of a JWT for the verifier to
   * reach for the signing key, which is the observable this test is after.
   * Minting a real one needs `@claxedo/workspace-relay` and `jose`, neither of
   * which resolves from this package.
   */
  function relayShapedToken() {
    const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
    return [
      segment({ alg: "EdDSA", kid: "relay-key-1", typ: "JWT" }),
      segment({ iss: "claxedo-relay", aud: "claxedo-workspace-host", host_id: "host_machine" }),
      Buffer.from("not-a-signature").toString("base64url"),
    ].join(".")
  }

  test("places a relayed caller when this test supplies no resolver of its own", async () => {
    const keySetRequests: string[] = []
    const keySet = createServer((request, response) => {
      keySetRequests.push(request.url ?? "")
      response.statusCode = 200
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ keys: [] }))
    })
    const keySetOrigin = await listen(keySet)

    await server?.stop()
    const port = await freePort()
    origin = `http://127.0.0.1:${port}`
    // No `runtimeProxyOptions`: `localHostRelayActor` is the only thing here
    // that can decide whether a relayed bearer names an actor.
    server = startLocalServer({ port })
    await server.ready
    const workspace = await resolveWorkspace()

    const serving = await fetch(`${origin}/api/claxedo/host-serving`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoints: { relayJwksUrl: `${keySetOrigin}/.well-known/jwks.json`, sessionAuthorityUrl: authorityUrl },
        credential: {
          hostId: "host_machine",
          enrollmentId: "enr_this_machine",
          // The tunnel dials this and gets no upgrade; what the test needs from
          // serving is the machine identity a relay token is bound to.
          relayUrl: keySetOrigin,
          hostTunnelToken: "host-tunnel-token",
          tokenExpiresAt: Date.now() + 600_000,
          jti: "jti_serving",
          workspaceIds: [workspace],
        },
      }),
    })
    expect(serving.status).toBe(200)
    expect(await serving.json()).toMatchObject({ serving: true })

    const refused = await status(`${origin}/workspaces/${workspace}/session/ses_x`, relayed(relayShapedToken()))

    expect(refused.code).toBe(403)
    expect(refused.error).toBe("relay_actor_unverified")
    // The refusal came from verifying the token against the relay's published
    // key set — which is this composition's resolver and not a stand-in.
    expect(keySetRequests).toContain("/.well-known/jwks.json")
    expect(authorityCalls).toEqual([])

    await fetch(`${origin}/api/claxedo/host-serving`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: null }),
    })
    await new Promise<void>((resolve) => { keySet.close(() => resolve()) })
  }, 60_000)
})
