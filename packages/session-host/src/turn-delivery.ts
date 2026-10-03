import { parseTurnDelivery, parseTurnExecutionAccess, type TurnDelivery, type TurnExecutionAccess } from "@claxedo/harness/contract"
import { asNumber, asRecord, asString } from "@claxedo/helpers/guards"
import { turnLeaseKey, type TurnLease, type TurnLeases } from "./turn-leases"

export type HeldTurn = { key: string; delivery: TurnDelivery; generation: string }

export type ControlPlaneFetch = (input: string, init: RequestInit) => Promise<Response>

export class TurnAuthorityError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfterMs?: number) {
    super(`The control plane refused the session host's turn: ${status} ${code}`)
    this.name = "TurnAuthorityError"
  }
}

const EXECUTION_RENEW_MS = 60_000

async function deliveryGeneration(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))
  return Array.from(bytes.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function waitRetryAfter(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

/**
 * The two control-plane calls a turn makes, each proven by the session's
 * current turn lease: `/turn-delivery` once per lease for its credentials,
 * plugins and provider definitions, and `/turn-execution` for the token that
 * reaches the workspace machine. Both are held for the lease and dropped
 * when its turn ends.
 */
export class SessionHostTurns {
  private readonly deliveries = new Map<string, Promise<HeldTurn>>()
  private readonly delivered = new Map<string, HeldTurn>()
  private readonly executions = new Map<string, Promise<TurnExecutionAccess>>()

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
      const turn = { key, delivery, generation: await deliveryGeneration([delivery.plugins, delivery.providerDefinitions]) }
      if (this.deliveries.get(key) === fetched) this.delivered.set(key, turn)
      return turn
    })
    this.deliveries.set(key, fetched)
    fetched.catch(() => { if (this.deliveries.get(key) === fetched) this.deliveries.delete(key) })
    return fetched
  }

  async execution(sessionId: string, signal: AbortSignal): Promise<TurnExecutionAccess> {
    const key = turnLeaseKey(this.lease(sessionId))
    const held = this.executions.get(key)
    if (held && (await held).expiresAt - Date.now() > EXECUTION_RENEW_MS) return held
    const fetched = this.executionAccess(sessionId, signal)
    this.executions.set(key, fetched)
    fetched.catch(() => { if (this.executions.get(key) === fetched) this.executions.delete(key) })
    return fetched
  }

  forget(lease: TurnLease): void {
    const key = turnLeaseKey(lease)
    this.deliveries.delete(key)
    this.delivered.delete(key)
    this.executions.delete(key)
  }

  private async executionAccess(sessionId: string, signal: AbortSignal): Promise<TurnExecutionAccess> {
    for (;;) {
      try {
        const access = parseTurnExecutionAccess(await this.post("turn-execution", this.lease(sessionId)))
        if (!access) throw new TurnAuthorityError(502, "turn_execution_invalid")
        return access
      } catch (error) {
        if (!(error instanceof TurnAuthorityError) || error.retryAfterMs === undefined) throw error
        await waitRetryAfter(error.retryAfterMs, signal)
      }
    }
  }

  private lease(sessionId: string): TurnLease {
    const lease = this.input.leases().current(sessionId)
    if (!lease) throw new TurnAuthorityError(401, "session_turn_lease_required")
    return lease
  }

  private async post(route: "turn-delivery" | "turn-execution", lease: TurnLease): Promise<unknown> {
    const response = await this.input.fetch(new URL(route, this.input.authorityUrl).href, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turnLease: lease.leaseId }),
    })
    const body: unknown = await response.json().catch(() => undefined)
    if (response.ok) return body
    const error = asRecord(asRecord(body)?.error)
    const retryAfterMs = response.status === 409 ? asNumber(error?.retryAfterMs) : undefined
    throw new TurnAuthorityError(response.status, asString(error?.code) ?? "turn_authority_unavailable", retryAfterMs)
  }
}
