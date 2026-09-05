/**
 * Keeps the daemon's signed Agent Plugins world in step with the account.
 *
 * The control plane is canonical for a signed user's activations and MCP
 * authentication; this machine only ever mirrors it. Main is the process that
 * holds the account credential, so main pulls `GET /api/claxedo/plugins/runtime/self`
 * (through the hosted-operation matrix, withheld from the renderer) and hands
 * the answer to the daemon's loopback surface, which materializes it and
 * launches every harness with it. Signing out withdraws it.
 *
 * Re-pulled on a timer because the gateway credentials in the answer are
 * short-lived: the daemon must hold a fresh bearer before the previous one
 * dies, and an activation made on another machine has no push channel to this
 * one. `expiresAt` from the control plane bounds the interval; without
 * credentials the interval is the plain refresh cadence.
 */

const REFRESH_INTERVAL_MS = 10 * 60_000
const REFRESH_LEAD_MS = 5 * 60_000
const RETRY_INTERVAL_MS = 60_000

type AccountState = { status: string }

export type AgentPluginsSignedSync = {
  /** Called on every account state change; idempotent. */
  follow(state: AccountState): void
  /** Force a pull now (an activation was just made from this machine). */
  refresh(): Promise<void>
  stop(): void
}

export function setupAgentPluginsSignedSync(input: {
  enabled: boolean
  runAccountOperation: (name: string, params?: Record<string, unknown>) => Promise<unknown>
  serverUrl: () => Promise<string>
  request?: (url: string, init?: RequestInit) => Promise<Response>
  log: { info(message: string): void; warn(message: string): void }
  setTimer?: (run: () => void, delayMs: number) => ReturnType<typeof setTimeout>
}): AgentPluginsSignedSync {
  const request = input.request ?? fetch
  const setTimer = input.setTimer ?? setTimeout
  let signed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let inFlight: Promise<void> | undefined

  const schedule = (delayMs: number) => {
    if (stopped || !signed) return
    if (timer) clearTimeout(timer)
    timer = setTimer(() => void sync(), delayMs)
    timer.unref?.()
  }

  const push = async (body: unknown) => {
    const response = await request(new URL("/api/claxedo/plugins/signed-runtime", await input.serverUrl()).toString(), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`daemon answered ${String(response.status)} ${text.slice(0, 200)}`)
    return text
  }

  const sync = async () => {
    if (!signed || stopped) return
    try {
      const result = await input.runAccountOperation("agentPlugins.runtimeSelf")
      const answer = result && typeof result === "object" && !Array.isArray(result)
        ? (result as { status?: unknown; body?: unknown })
        : undefined
      if (typeof answer?.status !== "number" || answer.status < 200 || answer.status >= 300) {
        throw new Error(`control plane answered ${String(answer?.status)}`)
      }
      const state = await push(answer.body)
      const body = answer.body as { revision?: unknown; expiresAt?: unknown } | undefined
      input.log.info(`[agent-plugins] signed world applied revision=${String(body?.revision)} -> ${state.slice(0, 120)}`)
      const expiresAt = typeof body?.expiresAt === "number" ? body.expiresAt : undefined
      const untilExpiry = expiresAt ? Math.max(RETRY_INTERVAL_MS, expiresAt - Date.now() - REFRESH_LEAD_MS) : REFRESH_INTERVAL_MS
      schedule(Math.min(REFRESH_INTERVAL_MS, untilExpiry))
    } catch (error) {
      input.log.warn(`[agent-plugins] signed world sync failed: ${String(error)}`)
      schedule(RETRY_INTERVAL_MS)
    }
  }

  const run = () => {
    inFlight = (inFlight ?? Promise.resolve()).then(sync, sync)
    return inFlight
  }

  const withdraw = async () => {
    try {
      await push(null)
      input.log.info("[agent-plugins] signed world withdrawn; the machine world launches")
    } catch (error) {
      input.log.warn(`[agent-plugins] signed world withdraw failed: ${String(error)}`)
    }
  }

  return {
    follow(state) {
      if (!input.enabled || stopped) return
      // A transient outage of the control plane (a release window, a network
      // blip) is not a sign-out: the signed world stays applied and the
      // refresh timer keeps retrying, so harnesses never fall back to the
      // machine world mid-session. Only an explicit unsigned state withdraws.
      if (state.status === "unavailable") return
      const next = state.status === "signed"
      if (next === signed) return
      signed = next
      if (timer) clearTimeout(timer)
      timer = undefined
      if (next) void run()
      else inFlight = (inFlight ?? Promise.resolve()).then(withdraw, withdraw)
    },
    async refresh() {
      if (!input.enabled || !signed) return
      await run()
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
