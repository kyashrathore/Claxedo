import { parseTurnDelivery, parseTurnExecutionAccess, type TurnDelivery, type TurnExecutionAccess } from "@claxedo/harness/contract"
import { asBoolean, asNumber, asRecord, asString } from "@claxedo/helpers/guards"
import { turnLeaseKey, type TurnLease, type TurnLeases } from "./turn-leases"

export type HeldTurn = { key: string; delivery: TurnDelivery; generation: string }

export type ControlPlaneFetch = (input: string, init: RequestInit) => Promise<Response>

export type TurnAuthorityRefusal = { started?: boolean; message?: string; retryAfterMs?: number; sinceStartMs?: number }

export class TurnAuthorityError extends Error {
  constructor(readonly status: number, readonly code: string, readonly refusal: TurnAuthorityRefusal = {}) {
    super(`The control plane refused the session host's turn: ${status} ${code}`)
    this.name = "TurnAuthorityError"
  }
}

/**
 * Whether a call that finds the workspace machine not running asks the
 * control plane to start it, and whether one that finds it starting waits for
 * it, as a tool call does.
 */
export type ExecutionRequest = { start: boolean; wait?: boolean }

const EXECUTION_RENEW_MS = 60_000

async function deliveryGeneration(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))
  return Array.from(bytes.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * The control-plane calls a turn makes, each proven by the session's current
 * turn lease: `/turn-delivery` once per lease for its credentials, plugins
 * and provider definitions, `/turn-execution` for the token that reaches the
 * workspace machine, and `/turn-credential-refused` when the vendor refused
 * one of the delivered accounts. The first two are held for the lease and
 * dropped when its turn ends. The plane refuses a machine that is not running
 * at once; the refusal says whether this call started it, when its start can
 * next answer differently, and how long it has run.
 */
const askedKey = (leaseKey: string, request: ExecutionRequest) => `${leaseKey}:${request.start ? "start" : "read"}`

export class SessionHostTurns {
  private readonly deliveries = new Map<string, Promise<HeldTurn>>()
  private readonly delivered = new Map<string, HeldTurn>()
  private readonly executions = new Map<string, TurnExecutionAccess>()
  private readonly asking = new Map<string, Promise<TurnExecutionAccess>>()

  constructor(private readonly input: { fetch: ControlPlaneFetch; authorityUrl: string; leases: () => TurnLeases }) {}

  held(sessionId: string): HeldTurn | undefined {
    const lease = this.input.leases().current(sessionId)
    return lease ? this.delivered.get(turnLeaseKey(lease)) : undefined
  }

  delivery(sessionId: string, options: { renew?: true } = {}): Promise<HeldTurn> {
    const lease = this.lease(sessionId)
    const key = turnLeaseKey(lease)
    const held = this.deliveries.get(key)
    const expired = (this.delivered.get(key)?.delivery.expiresAt ?? Infinity) <= Date.now()
    if (held && !options.renew && !expired) return held
    const fetched = this.post("turn-delivery", lease).then(async (body) => {
      const delivery = parseTurnDelivery(body)
      if (!delivery) throw new TurnAuthorityError(502, "turn_delivery_invalid")
      if (delivery.expiresAt <= Date.now()) throw new TurnAuthorityError(502, "turn_delivery_expired")
      const mcp = delivery.firstPartyMcp
      const generation = await deliveryGeneration([delivery.plugins, delivery.providerDefinitions, mcp ? [mcp.name, mcp.url, mcp.toolGroups] : null])
      const turn = { key, delivery, generation }
      if (this.deliveries.get(key) === fetched) this.delivered.set(key, turn)
      return turn
    })
    this.deliveries.set(key, fetched)
    fetched.catch(() => { if (this.deliveries.get(key) === fetched) this.deliveries.delete(key) })
    return fetched
  }

  execution(sessionId: string, request: ExecutionRequest): Promise<TurnExecutionAccess> {
    const lease = this.lease(sessionId)
    const key = turnLeaseKey(lease)
    const held = this.executions.get(key)
    if (held && held.expiresAt - Date.now() > EXECUTION_RENEW_MS) return Promise.resolve(held)
    const asked = askedKey(key, request)
    const pending = this.asking.get(asked)
    if (pending) return pending
    const fetched = this.post("turn-execution", lease, { start: request.start }).then((body) => {
      const access = parseTurnExecutionAccess(body)
      if (!access) throw new TurnAuthorityError(502, "turn_execution_invalid")
      if (this.asking.get(asked) === fetched) this.executions.set(key, access)
      return access
    })
    this.asking.set(asked, fetched)
    const settled = () => { if (this.asking.get(asked) === fetched) this.asking.delete(asked) }
    fetched.then(settled, settled)
    return fetched
  }

  forget(lease: TurnLease): void {
    const key = turnLeaseKey(lease)
    this.deliveries.delete(key)
    this.delivered.delete(key)
    this.executions.delete(key)
    for (const start of [true, false]) this.asking.delete(askedKey(key, { start }))
  }

  /** Tells the control plane the vendor answered `status` to the revision of a stored account the session's current turn was handed; the plane decides what that does to the account. */
  async credentialRefused(sessionId: string, refusal: { credentialId: string; revision: number; status: number }): Promise<void> {
    await this.post("turn-credential-refused", this.lease(sessionId), refusal)
  }

  private lease(sessionId: string): TurnLease {
    const lease = this.input.leases().current(sessionId)
    if (!lease) throw new TurnAuthorityError(401, "session_turn_lease_required")
    return lease
  }

  private async post(route: "turn-delivery" | "turn-execution" | "turn-credential-refused", lease: TurnLease, fields: Record<string, unknown> = {}): Promise<unknown> {
    const response = await this.input.fetch(new URL(route, this.input.authorityUrl).href, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turnLease: lease.leaseId, ...fields }),
    })
    const body: unknown = await response.json().catch(() => undefined)
    if (response.ok) return body
    const error = asRecord(asRecord(body)?.error)
    const started = asBoolean(error?.started)
    const message = asString(error?.message)
    const retryAfterMs = asNumber(error?.retryAfterMs)
    const sinceStartMs = asNumber(error?.sinceStartMs)
    throw new TurnAuthorityError(response.status, asString(error?.code) ?? "turn_authority_unavailable", {
      ...(started === undefined ? {} : { started }), ...(message ? { message } : {}),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }), ...(sinceStartMs === undefined ? {} : { sinceStartMs }),
    })
  }
}
