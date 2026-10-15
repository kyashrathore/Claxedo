import { Hono, type Context } from "hono"
import { SignJWT, jwtVerify } from "jose"
import { CLAXEDO_MCP_PATH, CLAXEDO_MCP_SERVER_INFO, CLAXEDO_MCP_TOOL_GROUPS, createClaxedoMcpRoutes } from "@claxedo/mcp"
import { createClaxedoMcpClient, type ClaxedoFetch } from "@claxedo/mcp/client"
import type { ProviderDirect, ProviderUnavailable } from "@claxedo/agent-runtime-contract"
import { asString } from "@claxedo/helpers/guards"
import type { RuntimeConfigSnapshotPlugins, TurnDelivery, TurnExecutionAccess } from "@claxedo/harness/contract"
import { bearerToken } from "@claxedo/session-core"
import { mintRuntimeAccessToken, verifyRelayHostToken } from "@claxedo/workspace-relay"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"

export const WORKSPACE_ID = "ws_session_host"
export const OWNER = "user_owner"
export const MACHINE_HOST = "host_machine"

type Lease = { sessionId: string; turnId: string; fencingToken: number; released: boolean; userId: string; expiresAt: number }

const WRITES: ReadonlySet<string> = new Set(["write", "start", "register", "turn_acquire", "turn_grant"])

export type ControlPlaneInput = {
  root: string
  relayHostKey: CryptoKey
  runtimeAccessKey: CryptoKey
  /** Each person's Pi accounts by user id; a person without an entry holds none. */
  accounts: () => Record<string, Record<string, ProviderDirect>>
  /** Each person's providers whose account the control plane refuses, with why. */
  refused?: () => Record<string, Record<string, ProviderUnavailable>>
  plugins: () => RuntimeConfigSnapshotPlugins
  machine: () => { relayUrl: string; directory: string; routingId?: string }
  /** The workspace runtime's root sessions, which the first-party MCP endpoint lists for a session that carries its turn's bearer. */
  workspaceSessions: () => Record<string, unknown>[]
  /** The session's own object, reached as the relay reaches it, for the first-party MCP endpoint's calls about that session. */
  sessionHost: () => ClaxedoFetch
}

/**
 * The control plane as the session host sees it over its service binding,
 * and nothing more. `/session-authorize` admits a caller whose relay host
 * token verifies for this session's host, refuses a create whose operation is
 * not the session's reservation and every write by a viewer, and mints real
 * turn-lease tokens it verifies again on renewal, release and delivery; an
 * acquire while another turn's lease is live is a 409, as on the real plane. A
 * deferred turn grant is minted for the caller and one turn id, and admits
 * that turn's acquire only when it arrives without a bearer and only once, as
 * the real authority redeems it: a later acquire under it is admitted only
 * while the lease it was redeemed for is live. A turn id in
 * `control.refusedTurns` is refused as if another turn held the session, and
 * `control.releaseDelayMs` holds every release that long before the lease is
 * released, as a control plane slow to answer does.
 * `/turn-delivery` hands over the session creator's accounts, as the real
 * route does, and with `firstPartyMcp` on a fresh first-party MCP bearer the
 * real `/api/claxedo/mcp` route below admits until the session is deleted;
 * `/turn-execution` mints a machine token while the machine runs, and
 * otherwise refuses at once, starting a sleeping machine only when the call
 * asks to and never one already starting, with `control.start`'s next-answer
 * delay and, for a start already running, how long it has run; `/session-host-delete` deletes the
 * session for anyone but a viewer.
 */
export function controlPlaneStandIn(input: ControlPlaneInput) {
  const leaseSecret = crypto.getRandomValues(new Uint8Array(32))
  const leases = new Map<string, Lease>()
  const calls = {
    deliveries: [] as string[], executions: [] as string[], releases: [] as string[], deletes: [] as string[], renewals: 0, mcpBearers: [] as string[],
    /** The turn each machine start was asked by. */
    starts: [] as string[],
    /** Each usage report: the turn whose lease proved it and the facts it carried. */
    usage: [] as Array<{ turnId: string; released: boolean; facts: Record<string, unknown>[] }>,
    /** Each session rows publication: the turn whose lease was its bearer and the rows it carried. */
    rows: [] as Array<{ turnId: string; released: boolean; hostId: string; rows: Record<string, unknown>[] }>,
    /** Each stored account the host reported the vendor refusing, with the turn that spent it. */
    refusals: [] as Array<{ turnId: string; credentialId: string; revision: unknown; status: unknown }>,
  }
  const mcpBearers = new Set<string>()
  let fencing = 0
  let creator: string | undefined
  let deleted = false
  const control = {
    refuseRenewals: false, leaseTtlMs: 60_000, reservation: `op_${input.root}`, viewers: new Set<string>(),
    machine: "running" as "running" | "asleep" | "starting", deleteUnavailable: false, firstPartyMcp: false, toolGroups: ["sessions"],
    refusedTurns: new Set<string>(), releaseDelayMs: 0,
    start: { retryAfterMs: 60_000, sinceStartMs: 35_000 },
  }
  const redeemedGrants = new Map<string, string>()

  const mint = async (lease: Lease) => {
    const expiresAt = Date.now() + control.leaseTtlMs
    lease.expiresAt = expiresAt
    const token = await new SignJWT({ sessionId: lease.sessionId, turnId: lease.turnId, fencingToken: lease.fencingToken })
      .setProtectedHeader({ alg: "HS256" }).setExpirationTime(Math.floor(expiresAt / 1000)).sign(leaseSecret)
    return { allowed: true, turnId: lease.turnId, leaseId: token, fencingToken: lease.fencingToken, acquiredAt: Date.now(), expiresAt }
  }
  /** The lease a token stands for, released or not: what a usage report or a row publication after the release is proven by. */
  const issuedLease = async (token: unknown): Promise<Lease | undefined> => {
    if (typeof token !== "string") return undefined
    const verified = await jwtVerify(token, leaseSecret).catch(() => undefined)
    const lease = verified ? leases.get(String(verified.payload.turnId)) : undefined
    return lease && lease.fencingToken === verified?.payload.fencingToken ? lease : undefined
  }
  const liveLease = async (token: unknown): Promise<Lease | undefined> => {
    const lease = await issuedLease(token)
    return lease && !lease.released ? lease : undefined
  }
  const relayCaller = async (c: Context) => {
    const token = bearerToken(c.req.header("authorization"))
    const claims = token
      ? await verifyRelayHostToken(token, input.relayHostKey, { workspaceId: WORKSPACE_ID, hostId: sessionHostId(input.root) }).catch(() => undefined)
      : undefined
    return claims ? claims.user_id ?? claims.actor_id : undefined
  }
  const acquire = async (c: Context, turnId: string, userId: string) => {
    const held = [...leases.values()].find((lease) => !lease.released && lease.expiresAt > Date.now() && lease.turnId !== turnId)
    if (held || control.refusedTurns.has(turnId)) return c.json({ error: { code: "session_turn_in_progress" } }, 409)
    const lease = { sessionId: input.root, turnId, fencingToken: ++fencing, released: false, userId, expiresAt: 0 }
    leases.set(turnId, lease)
    return c.json(await mint(lease))
  }
  const refused = (c: Context, status: 400 | 401 | 403, code: string) => c.json({ error: { code } }, status)

  const runtime = new Hono()
    .get("/experimental/session", (c) => c.json(input.workspaceSessions()))
    .get("/session/status", (c) => c.json({}))
  const mcpIsolate = () => new Hono().route(CLAXEDO_MCP_PATH, createClaxedoMcpRoutes({
    mount: "hosted",
    verifyRuntimeCredential: (token) => {
      calls.mcpBearers.push(token)
      if (!mcpBearers.has(token) || deleted || !creator) return undefined
      return { runtimeId: sessionHostId(input.root), workspaceId: WORKSPACE_ID, sessionId: input.root, userId: creator, expiresAt: Date.now() + control.leaseTtlMs }
    },
    createClient: () => createClaxedoMcpClient({
      deployment: "hosted",
      local: { fetch: async (path, init) => await runtime.request(path, init), workspace: { workspaceId: WORKSPACE_ID } },
      ownSession: { sessionId: input.root, fetch: (path, init) => input.sessionHost()(path, init) },
    }),
    registerTools: CLAXEDO_MCP_TOOL_GROUPS,
    enabledToolGroups: () => control.toolGroups,
    audit: () => {},
  }).routes)
  let mcp = mcpIsolate()
  const firstPartyMcp = (origin: string) => {
    const token = `session-mcp-${crypto.randomUUID()}`
    mcpBearers.add(token)
    const url = new URL(CLAXEDO_MCP_PATH, origin)
    url.searchParams.set("session", input.root)
    return { name: CLAXEDO_MCP_SERVER_INFO.name, url: url.href, token, toolGroups: control.toolGroups }
  }

  const authority = new Hono()
    .post("/session-authorize", async (c) => {
      const body = await c.req.json<Record<string, unknown>>()
      const action = String(body.action)
      if (action === "usage_report") {
        const lease = await issuedLease(body.leaseId)
        const facts = Array.isArray(body.facts) ? body.facts as Record<string, unknown>[] : []
        if (!lease || body.sessionId !== lease.sessionId || body.turnId !== lease.turnId || body.fencingToken !== lease.fencingToken) return refused(c, 401, "session_turn_lease_invalid")
        calls.usage.push({ turnId: lease.turnId, released: lease.released, facts })
        return c.json({ results: facts.map((fact) => ({ messageId: fact.messageId, revision: fact.revision, status: "accepted" })) })
      }
      if (action === "turn_renew" || action === "turn_release") {
        const lease = await liveLease(body.leaseId)
        if (!lease) return refused(c, 401, "session_turn_lease_invalid")
        if (action === "turn_release") {
          await new Promise((resolve) => setTimeout(resolve, control.releaseDelayMs))
          lease.released = true
          calls.releases.push(lease.turnId)
          return c.json({ released: true })
        }
        calls.renewals += 1
        return control.refuseRenewals ? refused(c, 401, "session_turn_lease_invalid") : c.json(await mint(lease))
      }
      if (action === "turn_acquire" && typeof body.grant === "string") {
        if (c.req.header("authorization")) return refused(c, 400, "session_turn_grant_invalid")
        const granted = await jwtVerify(body.grant, leaseSecret).catch(() => undefined)
        const userId = asString(granted?.payload.grantedTo)
        if (!userId || granted?.payload.sessionId !== input.root || granted.payload.turnId !== body.turnId || deleted) return refused(c, 401, "session_turn_grant_invalid")
        const redeemedFor = redeemedGrants.get(body.grant)
        const redeemedLease = redeemedFor === undefined ? undefined : leases.get(redeemedFor)
        if (redeemedFor !== undefined && (!redeemedLease || redeemedLease.released || redeemedLease.expiresAt <= Date.now())) return refused(c, 403, "session_turn_grant_redeemed")
        const answer = await acquire(c, String(body.turnId), userId)
        if (answer.ok) redeemedGrants.set(body.grant, String(body.turnId))
        return answer
      }
      const userId = await relayCaller(c)
      if (!userId || body.sessionId !== input.root || deleted) return refused(c, 403, "session_private")
      if (WRITES.has(action) && control.viewers.has(userId)) return refused(c, 403, "workspace_authorization_denied")
      if ((action === "start" || action === "register") && body.operationId !== control.reservation) return refused(c, 403, "workspace_authorization_denied")
      if (action === "register") creator = userId
      if (action === "turn_grant") {
        const expiresAt = Date.now() + control.leaseTtlMs
        const grant = await new SignJWT({ sessionId: input.root, turnId: body.turnId, grantedTo: userId })
          .setProtectedHeader({ alg: "HS256" }).setExpirationTime(Math.floor(expiresAt / 1000)).sign(leaseSecret)
        return c.json({ grant, expiresAt })
      }
      if (action === "turn_acquire") return acquire(c, String(body.turnId), userId)
      if (body.stream === true) return c.json({ lease: `stream_${crypto.randomUUID()}`, expiresAt: Date.now() + 15_000 })
      return c.json({ allowed: true })
    })
    .post("/turn-delivery", async (c) => {
      const refusals = (person: string) => {
        const refused = input.refused?.()[person]
        return refused ? { [person]: refused } : {}
      }
      const lease = await liveLease((await c.req.json<{ turnLease?: string }>()).turnLease)
      if (!lease || !creator) return refused(c, 401, "session_turn_lease_invalid")
      calls.deliveries.push(lease.turnId)
      const delivery: TurnDelivery = {
        expiresAt: Date.now() + control.leaseTtlMs,
        auth: { machineOwnerUserId: OWNER, accounts: refusals(creator), direct: { [creator]: input.accounts()[creator] ?? {} } },
        plugins: input.plugins(),
        providerDefinitions: [],
        ...(control.firstPartyMcp ? { firstPartyMcp: firstPartyMcp(new URL(c.req.url).origin) } : {}),
        directory: input.machine().directory,
      }
      return c.json(delivery)
    })
    .post("/turn-execution", async (c) => {
      const body = await c.req.json<{ turnLease?: string; start?: boolean }>()
      const lease = await liveLease(body.turnLease)
      if (!lease) return refused(c, 401, "session_turn_lease_invalid")
      calls.executions.push(lease.turnId)
      if (control.machine !== "running") {
        if (body.start !== true) return c.json({ error: { code: "cloud_runtime_unavailable" } }, 409)
        const started = control.machine === "asleep"
        if (started) {
          control.machine = "starting"
          calls.starts.push(lease.turnId)
        }
        const { retryAfterMs, sinceStartMs } = control.start
        return c.json({ error: { code: "cloud_runtime_starting", started, retryAfterMs, ...(started ? {} : { sinceStartMs }) } }, 409)
      }
      const expiresAt = Date.now() + 600_000
      const runtimeAccessToken = await mintRuntimeAccessToken({
        principalKind: "user", actorId: lease.userId, userId: lease.userId, actorKind: "human", orgId: "org_1", workspaceId: WORKSPACE_ID,
        hostId: MACHINE_HOST, role: "editor", sessionId: input.root, purpose: "turn-execution", ttlSeconds: 600,
      }, input.runtimeAccessKey, "EdDSA")
      const access: TurnExecutionAccess = { ...input.machine(), workspaceId: WORKSPACE_ID, hostId: MACHINE_HOST, runtimeAccessToken, expiresAt }
      return c.json(access)
    })
    .post("/turn-credential-refused", async (c) => {
      const body = await c.req.json<{ turnLease?: string; credentialId?: string; revision?: unknown; status?: unknown }>()
      const lease = await issuedLease(body.turnLease)
      if (!lease || typeof body.credentialId !== "string") return refused(c, 401, "session_turn_lease_invalid")
      calls.refusals.push({ turnId: lease.turnId, credentialId: body.credentialId, revision: body.revision, status: body.status })
      return c.json({ refusal: "waiting" })
    })
    .post("/session-host-delete", async (c) => {
      const userId = await relayCaller(c)
      if (!userId || (await c.req.json<{ sessionId?: string }>()).sessionId !== input.root || deleted) return refused(c, 403, "session_host_delete_denied")
      if (control.viewers.has(userId)) return refused(c, 403, "session_host_delete_denied")
      if (control.deleteUnavailable) return c.json({ error: { code: "control_plane_unavailable" } }, 503)
      calls.deletes.push(userId)
      deleted = true
      return c.json({ deleted: true })
    })
  const sessionRows = new Hono().post("/", async (c) => {
    const lease = await issuedLease(bearerToken(c.req.header("authorization")))
    const body = await c.req.json<{ hostId: string; rows: Record<string, unknown>[]; removed: unknown[] }>()
    if (!lease || body.hostId !== sessionHostId(input.root) || body.removed.length || body.rows.some((row) => row.sessionId !== input.root || row.workspaceId !== WORKSPACE_ID)) {
      return refused(c, 401, "invalid_session_turn_lease")
    }
    calls.rows.push({ turnId: lease.turnId, released: lease.released, hostId: body.hostId, rows: body.rows })
    return c.json({ accepted: body.rows.length, refused: [] })
  })
  const app = new Hono()
    .route("/api/runtime-authority", authority)
    .route("/api/claxedo/host/session-rows", sessionRows)
    .all(CLAXEDO_MCP_PATH, (c) => mcp.fetch(c.req.raw))
  /** Every later MCP request lands on an endpoint that shares no memory with the one before, as on another Worker isolate. */
  const newMcpIsolate = () => { mcp = mcpIsolate() }
  return { fetch: (request: Request) => app.fetch(request), calls, control, newMcpIsolate }
}
