import { Hono, type Context } from "hono"
import { SignJWT, jwtVerify } from "jose"
import type { ProviderDirect } from "@claxedo/agent-runtime-contract"
import type { RuntimeConfigSnapshotPlugins, TurnDelivery, TurnExecutionAccess } from "@claxedo/harness/contract"
import { bearerToken } from "@claxedo/session-core"
import { mintRuntimeAccessToken, verifyRelayHostToken } from "@claxedo/workspace-relay"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"

export const WORKSPACE_ID = "ws_session_host"
export const OWNER = "user_owner"
export const MACHINE_HOST = "host_machine"

type Lease = { sessionId: string; turnId: string; fencingToken: number; released: boolean; userId: string }

const WRITES: ReadonlySet<string> = new Set(["write", "start", "register", "turn_acquire", "turn_grant"])

export type ControlPlaneInput = {
  root: string
  relayHostKey: CryptoKey
  runtimeAccessKey: CryptoKey
  /** Each person's Pi accounts by user id; a person without an entry holds none. */
  accounts: () => Record<string, Record<string, ProviderDirect>>
  plugins: () => RuntimeConfigSnapshotPlugins
  machine: () => { relayUrl: string; directory: string; routingId?: string }
}

/**
 * The control plane as the session host sees it over its service binding,
 * and nothing more. `/session-authorize` admits a caller whose relay host
 * token verifies for this session's host, refuses a create whose operation is
 * not the session's reservation and every write by a viewer, and mints real
 * turn-lease tokens it verifies again on renewal, release and delivery.
 * `/turn-delivery` hands over the session creator's accounts, as the real
 * route does, `/turn-execution` mints a machine token, and
 * `/session-host-delete` deletes the session for anyone but a viewer.
 */
export function controlPlaneStandIn(input: ControlPlaneInput) {
  const leaseSecret = crypto.getRandomValues(new Uint8Array(32))
  const leases = new Map<string, Lease>()
  const calls = { deliveries: [] as string[], executions: [] as string[], releases: [] as string[], deletes: [] as string[], renewals: 0 }
  let fencing = 0
  let creator: string | undefined
  let deleted = false
  const control = {
    refuseRenewals: false, leaseTtlMs: 60_000, reservation: `op_${input.root}`, viewers: new Set<string>(),
    executionUnavailable: false, deleteUnavailable: false,
  }

  const mint = async (lease: Lease) => {
    const expiresAt = Date.now() + control.leaseTtlMs
    const token = await new SignJWT({ sessionId: lease.sessionId, turnId: lease.turnId, fencingToken: lease.fencingToken })
      .setProtectedHeader({ alg: "HS256" }).setExpirationTime(Math.floor(expiresAt / 1000)).sign(leaseSecret)
    return { allowed: true, turnId: lease.turnId, leaseId: token, fencingToken: lease.fencingToken, acquiredAt: Date.now(), expiresAt }
  }
  const liveLease = async (token: unknown): Promise<Lease | undefined> => {
    if (typeof token !== "string") return undefined
    const verified = await jwtVerify(token, leaseSecret).catch(() => undefined)
    const lease = verified ? leases.get(String(verified.payload.turnId)) : undefined
    return lease && !lease.released && lease.fencingToken === verified?.payload.fencingToken ? lease : undefined
  }
  const relayCaller = async (c: Context) => {
    const token = bearerToken(c.req.header("authorization"))
    const claims = token
      ? await verifyRelayHostToken(token, input.relayHostKey, { workspaceId: WORKSPACE_ID, hostId: sessionHostId(input.root) }).catch(() => undefined)
      : undefined
    return claims ? claims.user_id ?? claims.actor_id : undefined
  }
  const refused = (c: Context, status: 401 | 403, code: string) => c.json({ error: { code } }, status)

  const app = new Hono().basePath("/api/runtime-authority")
    .post("/session-authorize", async (c) => {
      const body = await c.req.json<Record<string, unknown>>()
      const action = String(body.action)
      if (action === "turn_renew" || action === "turn_release") {
        const lease = await liveLease(body.leaseId)
        if (!lease) return refused(c, 401, "session_turn_lease_invalid")
        if (action === "turn_release") {
          lease.released = true
          calls.releases.push(lease.turnId)
          return c.json({ released: true })
        }
        calls.renewals += 1
        return control.refuseRenewals ? refused(c, 401, "session_turn_lease_invalid") : c.json(await mint(lease))
      }
      const userId = await relayCaller(c)
      if (!userId || body.sessionId !== input.root || deleted) return refused(c, 403, "session_private")
      if (WRITES.has(action) && control.viewers.has(userId)) return refused(c, 403, "workspace_authorization_denied")
      if ((action === "start" || action === "register") && body.operationId !== control.reservation) return refused(c, 403, "workspace_authorization_denied")
      if (action === "register") creator = userId
      if (action === "turn_acquire") {
        const lease = { sessionId: input.root, turnId: String(body.turnId), fencingToken: ++fencing, released: false, userId }
        leases.set(lease.turnId, lease)
        return c.json(await mint(lease))
      }
      if (body.stream === true) return c.json({ lease: `stream_${crypto.randomUUID()}`, expiresAt: Date.now() + 15_000 })
      return c.json({ allowed: true })
    })
    .post("/turn-delivery", async (c) => {
      const lease = await liveLease((await c.req.json<{ turnLease?: string }>()).turnLease)
      if (!lease || !creator) return refused(c, 401, "session_turn_lease_invalid")
      calls.deliveries.push(lease.turnId)
      const delivery: TurnDelivery = {
        expiresAt: Date.now() + control.leaseTtlMs,
        auth: { machineOwnerUserId: OWNER, accounts: {}, direct: { [creator]: input.accounts()[creator] ?? {} } },
        plugins: input.plugins(),
        providerDefinitions: [],
      }
      return c.json(delivery)
    })
    .post("/turn-execution", async (c) => {
      const lease = await liveLease((await c.req.json<{ turnLease?: string }>()).turnLease)
      if (!lease) return refused(c, 401, "session_turn_lease_invalid")
      calls.executions.push(lease.turnId)
      if (control.executionUnavailable) return c.json({ error: { code: "cloud_runtime_unavailable", retryAfterMs: 200 } }, 409)
      const expiresAt = Date.now() + 600_000
      const runtimeAccessToken = await mintRuntimeAccessToken({
        principalKind: "user", actorId: lease.userId, userId: lease.userId, actorKind: "human", orgId: "org_1", workspaceId: WORKSPACE_ID,
        hostId: MACHINE_HOST, role: "editor", sessionId: input.root, purpose: "turn-execution", ttlSeconds: 600,
      }, input.runtimeAccessKey, "EdDSA")
      const access: TurnExecutionAccess = { ...input.machine(), workspaceId: WORKSPACE_ID, hostId: MACHINE_HOST, runtimeAccessToken, expiresAt }
      return c.json(access)
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
  return { fetch: (request: Request) => app.fetch(request), calls, control }
}
