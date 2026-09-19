import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import {
  configureAgentConfig,
  disposeAgentConfig,
  saveUserConfig,
} from "@claxedo/server-core/agent-config/index"
import { NO_HARNESS_EFFORT, type ConnectionProvider } from "@claxedo/agent-sdk-runtime"
import { startLocalServer, type LocalServer } from "./start-local-server"
import {
  configureEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
} from "../deployments/local/embedded-workspace-runtime"
import {
  localHostSessionAccessPolicy,
  resetLocalHostSessionAdoptions,
  setLocalHostEndpoints,
} from "../deployments/local/host-session-authority"

/**
 * Sessions that existed on the machine before its owner turned remote access
 * on, reached over the relay for the first time.
 *
 * The control plane has no row for such a session, and a read of a session it
 * has no row for is refused exactly as a read of someone else's is — so
 * nothing the owner made locally would ever be reachable from the web without
 * the daemon claiming it on that first refusal. What is proven here is that
 * the claim happens for the machine's owner and for nobody else, against the
 * real daemon with a real transcript on it.
 */

const OWNER = { actorId: "actor_owner", actorPublicId: "user_owner", actorName: "Owner", role: "owner" as const }
const MEMBER = { actorId: "actor_member", actorPublicId: "user_member", actorName: "Member", role: "editor" as const }
/** Holds the workspace outright, but is not the person this machine is enrolled to. */
const CO_OWNER = { actorId: "actor_co_owner", actorPublicId: "user_co_owner", actorName: "Co-owner", role: "owner" as const }

const CONNECTION_ID = "adoption_fixture"

const bearers = new Map<string, typeof OWNER | typeof MEMBER | typeof CO_OWNER>([
  ["owner-token", OWNER],
  ["member-token", MEMBER],
  ["co-owner-token", CO_OWNER],
])

type AuthorityCall = { action: string; sessionId?: string; actorId?: string }

let dataDir: string
let previousDataDir: string | undefined
let server: LocalServer | undefined
let authority: Server | undefined
let origin: string
let authorityCalls: AuthorityCall[]
/** Sessions the control plane has a row for, and the actor it named as creator. */
let registered: Map<string, string>
/** What `adopt` answers before it would write, standing for the plane's own refusals. */
let adoptionFault: { status: number; code: string } | undefined

const capabilities = {
  abort: false, reconnect: false, replay: true, permissions: false, questions: false,
  todos: false, commands: false, fork: false, revert: false, unrevert: false,
  configOptions: false, subagents: false,
}

/** Enough of a harness for the runtime to record a transcript; it is never prompted. */
const provider: ConnectionProvider<Record<string, never>> = {
  providerKey: "adoption-fixture-provider",
  validateConfig: () => ({}),
  project: () => ({ label: "Adoption fixture", readiness: "ready", capabilities }),
  resolve: () => ({ config: {} }),
  createAdapter: () => ({
    sessionConfigOwner: "runtime",
    instructionChannel: "none" as const,
    async createSession(_directory, _title, id) { return { id: id!, agentSessionId: "adoption-fixture" } },
    async getSession() { return null },
    async getMessages() { return [] },
    async updateSession() { return null },
    async deleteSession() {},
    async getSessionConfig() { throw new Error("runtime-owned config") },
    async updateSessionConfig() { throw new Error("runtime-owned config") },
    readHarnessCapabilities: () => ({
      ...capabilities,
      goals: false,
      harness: "adoption-fixture",
      effortLevels: NO_HARNESS_EFFORT,
      instructionChannel: "none" as const,
    }),
    async *executeTurn() {},
    dispose() {},
  }),
}

/**
 * The control plane reduced to its session rows: a read needs one naming the
 * caller, and `adopt` writes one for the owner of the machine, once.
 */
function fakeAuthority() {
  return createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => { raw += chunk })
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as { action?: string; sessionId?: string }
      const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1]
      const caller = bearer ? bearers.get(bearer) : undefined
      const sessionId = body.sessionId ?? ""
      authorityCalls.push({
        action: String(body.action),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        ...(caller ? { actorId: caller.actorId } : {}),
      })
      response.setHeader("content-type", "application/json")
      const refuse = (status: number, code: string) => {
        response.statusCode = status
        response.end(JSON.stringify({ error: { code, message: code } }))
      }
      if (!caller) return refuse(403, "workspace_authorization_denied")
      if (body.action === "adopt") {
        if (adoptionFault) return refuse(adoptionFault.status, adoptionFault.code)
        // The plane resolves the machine's enrollment owner; a workspace role
        // of owner is not the same person and is refused there.
        if (caller.actorId !== OWNER.actorId) return refuse(403, "session_adoption_requires_host_owner")
        const held = registered.get(sessionId)
        if (held && held !== caller.actorId) return refuse(403, "workspace_authorization_denied")
        registered.set(sessionId, caller.actorId)
        response.statusCode = 200
        return response.end(JSON.stringify({ allowed: true, adopted: !held }))
      }
      if (registered.get(sessionId) !== caller.actorId) return refuse(403, "workspace_authorization_denied")
      response.statusCode = 200
      response.end(JSON.stringify({ allowed: true, lease: "stream_lease", expiresAt: Date.now() + 60_000 }))
    })
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

function relayed(token: string) {
  return { authorization: `Bearer ${token}`, "x-forwarded-by": "workspace-relay" }
}

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-desktop-adoption-"))
  previousDataDir = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
  authorityCalls = []
  registered = new Map()
  adoptionFault = undefined
  resetLocalHostSessionAdoptions()

  authority = fakeAuthority()
  setLocalHostEndpoints({ sessionAuthorityUrl: `${await listen(authority)}/api/runtime-authority/session-authorize` })

  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  server = startLocalServer({
    port,
    runtimeProxyOptions: {
      resolveRelayActor: async (request) => {
        const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
        const actor = bearer ? bearers.get(bearer) : undefined
        if (!actor) return undefined
        return { ...actor, actorKind: "human" as const, orgId: "org_1" }
      },
    },
  })
  await server.ready
  // `startLocalServer` composes the two real harnesses, neither of which can
  // run here; the policy and the loopback declaration are re-supplied because
  // this call replaces the whole composition it made.
  configureEmbeddedWorkspaceRuntime({
    connectionProviders: [provider],
    sessionAccessPolicy: localHostSessionAccessPolicy,
    loopbackSessionAuthority: "local",
  })
  configureAgentConfig({ connectionProviders: [provider] })
  await saveUserConfig({
    version: 3,
    mcp: {},
    connections: {
      [CONNECTION_ID]: {
        connectionId: CONNECTION_ID,
        providerKey: provider.providerKey,
        configRevision: 1,
        enabled: true,
        config: {},
      },
    },
  })
})

afterEach(async () => {
  await shutdownEmbeddedWorkspaceRuntimes()
  await server?.stop()
  server = undefined
  disposeAgentConfig()
  configureEmbeddedWorkspaceRuntime({})
  configureAgentConfig()
  setLocalHostEndpoints(undefined)
  resetLocalHostSessionAdoptions()
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

async function workspaceWithLocalSession(sessionId: string) {
  const directory = path.join(dataDir, "project")
  mkdirSync(directory)
  execFileSync("git", ["init", directory])
  const resolved = await fetch(`${origin}/api/workspace/resolve?directory=${encodeURIComponent(directory)}&create=true`)
  expect(resolved.status).toBe(200)
  const { workspaceId } = await resolved.json() as { workspaceId: string }
  // Created the way the user at the keyboard creates one: loopback, no relay
  // marks, no reservation, before remote access exists.
  const created = await fetch(`${origin}/workspaces/${workspaceId}/session?connectionId=${CONNECTION_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: sessionId, title: "Before sharing" }),
  })
  expect(created.status).toBe(201)
  return workspaceId
}

async function read(workspaceId: string, sessionId: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}/workspaces/${workspaceId}/session/${sessionId}`, { headers })
  const body = await response.json() as { id?: string; error?: { code?: string } }
  return { status: response.status, id: body.id, error: body.error?.code }
}

describe("a session the machine held before remote access", () => {
  test("the owner's first relayed read claims it; another member is still refused", async () => {
    const workspaceId = await workspaceWithLocalSession("ses_before_sharing")

    const owner = await read(workspaceId, "ses_before_sharing", relayed("owner-token"))
    const member = await read(workspaceId, "ses_before_sharing", relayed("member-token"))

    expect(owner.status).toBe(200)
    expect(owner.id).toBe("ses_before_sharing")
    expect(member.status).toBe(403)
    expect(registered.get("ses_before_sharing")).toBe(OWNER.actorId)
    expect(authorityCalls.map((call) => `${call.action}:${call.actorId}`)).toEqual([
      `read:${OWNER.actorId}`,
      `adopt:${OWNER.actorId}`,
      `read:${OWNER.actorId}`,
      `read:${MEMBER.actorId}`,
    ])
  })

  test("the claim is made once and the machine's own user never causes one", async () => {
    const workspaceId = await workspaceWithLocalSession("ses_before_sharing")

    expect((await read(workspaceId, "ses_before_sharing", relayed("owner-token"))).status).toBe(200)
    expect((await read(workspaceId, "ses_before_sharing", relayed("owner-token"))).status).toBe(200)
    expect(authorityCalls.filter((call) => call.action === "adopt")).toHaveLength(1)

    authorityCalls = []
    expect((await read(workspaceId, "ses_before_sharing")).status).toBe(200)
    expect(authorityCalls).toEqual([])
  })

  test("two concurrent first reads make one claim between them", async () => {
    const workspaceId = await workspaceWithLocalSession("ses_before_sharing")

    const both = await Promise.all([
      read(workspaceId, "ses_before_sharing", relayed("owner-token")),
      read(workspaceId, "ses_before_sharing", relayed("owner-token")),
    ])

    expect(both.map((answer) => answer.status)).toEqual([200, 200])
    expect(authorityCalls.filter((call) => call.action === "adopt")).toHaveLength(1)
  })

  test("a session id this machine does not hold is never claimed", async () => {
    const workspaceId = await workspaceWithLocalSession("ses_before_sharing")

    const answer = await read(workspaceId, "ses_never_existed", relayed("owner-token"))

    expect(answer.status).toBe(403)
    expect(authorityCalls.some((call) => call.action === "adopt")).toBe(false)
  })

  test("a second workspace owner does not inherit the machine owner's claim", async () => {
    const workspaceId = await workspaceWithLocalSession("ses_before_sharing")

    expect((await read(workspaceId, "ses_before_sharing", relayed("owner-token"))).status).toBe(200)
    const other = await read(workspaceId, "ses_before_sharing", relayed("co-owner-token"))

    expect(other.status).toBe(403)
    expect(registered.get("ses_before_sharing")).toBe(OWNER.actorId)
  })

  test("a refused claim is not retried, and one the authority could not answer is", async () => {
    const workspaceId = await workspaceWithLocalSession("ses_before_sharing")
    adoptionFault = { status: 403, code: "workspace_authorization_denied" }

    expect((await read(workspaceId, "ses_before_sharing", relayed("owner-token"))).status).toBe(403)
    expect((await read(workspaceId, "ses_before_sharing", relayed("owner-token"))).status).toBe(403)
    expect(authorityCalls.filter((call) => call.action === "adopt")).toHaveLength(1)

    adoptionFault = { status: 500, code: "authority_unavailable" }
    resetLocalHostSessionAdoptions()
    expect((await read(workspaceId, "ses_before_sharing", relayed("owner-token"))).status).toBe(403)
    adoptionFault = undefined
    expect((await read(workspaceId, "ses_before_sharing", relayed("owner-token"))).status).toBe(200)
    expect(authorityCalls.filter((call) => call.action === "adopt")).toHaveLength(3)
  })
})
