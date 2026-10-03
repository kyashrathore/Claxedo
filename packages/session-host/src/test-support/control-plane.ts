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

type Lease = { sessionId: string; turnId: string; fencingToken: number; released: boolean }

export type ControlPlaneInput = {
  root: string
  relayHostKey: CryptoKey
  runtimeAccessKey: CryptoKey
  direct: () => ProviderDirect
  plugins: () => RuntimeConfigSnapshotPlugins
  machine: () => { relayUrl: string; directory: string }
}

/**
 * The control plane as the session host sees it over its service binding,
 * and nothing more: `/session-authorize` answers every caller whose relay host
 * token verifies for this session's host and mints real turn-lease tokens it
 * verifies again on renewal, release and delivery; `/turn-delivery` and
 * `/turn-execution` answer the live lease as the authority's own routes do.
 */
export function controlPlaneStandIn(input: ControlPlaneInput) {
  const leaseSecret = crypto.getRandomValues(new Uint8Array(32))
  const leases = new Map<string, Lease>()
  const calls = { deliveries: [] as string[], executions: [] as string[], releases: [] as string[], renewals: 0 }
  let fencing = 0
  const control = { refuseRenewals: false, leaseTtlMs: 60_000 }

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
    return token ? verifyRelayHostToken(token, input.relayHostKey, { workspaceId: WORKSPACE_ID, hostId: sessionHostId(input.root) }).catch(() => undefined) : undefined
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
      if (!await relayCaller(c) || body.sessionId !== input.root) return refused(c, 403, "session_private")
      if (action === "turn_acquire") {
        const lease = { sessionId: input.root, turnId: String(body.turnId), fencingToken: ++fencing, released: false }
        leases.set(lease.turnId, lease)
        return c.json(await mint(lease))
      }
      if (body.stream === true) return c.json({ lease: `stream_${crypto.randomUUID()}`, expiresAt: Date.now() + 15_000 })
      return c.json({ allowed: true })
    })
    .post("/turn-delivery", async (c) => {
      const lease = await liveLease((await c.req.json<{ turnLease?: string }>()).turnLease)
      if (!lease) return refused(c, 401, "session_turn_lease_invalid")
      calls.deliveries.push(lease.turnId)
      const delivery: TurnDelivery = {
        expiresAt: Date.now() + control.leaseTtlMs,
        auth: { machineOwnerUserId: OWNER, accounts: {}, direct: { [OWNER]: { openai: input.direct() } } },
        plugins: input.plugins(),
        providerDefinitions: [],
      }
      return c.json(delivery)
    })
    .post("/turn-execution", async (c) => {
      const lease = await liveLease((await c.req.json<{ turnLease?: string }>()).turnLease)
      if (!lease) return refused(c, 401, "session_turn_lease_invalid")
      calls.executions.push(lease.turnId)
      const expiresAt = Date.now() + 600_000
      const runtimeAccessToken = await mintRuntimeAccessToken({
        principalKind: "user", actorId: OWNER, userId: OWNER, actorKind: "human", orgId: "org_1", workspaceId: WORKSPACE_ID,
        hostId: MACHINE_HOST, role: "editor", sessionId: input.root, purpose: "turn-execution", ttlSeconds: 600,
      }, input.runtimeAccessKey, "EdDSA")
      const access: TurnExecutionAccess = { ...input.machine(), workspaceId: WORKSPACE_ID, hostId: MACHINE_HOST, runtimeAccessToken, expiresAt }
      return c.json(access)
    })
  return { fetch: (request: Request) => app.fetch(request), calls, control }
}
