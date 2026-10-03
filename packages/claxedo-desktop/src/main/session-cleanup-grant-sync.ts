import { decodeHostedResult, type HostedOperationName } from "@claxedo/account-contract"
import { CLAXEDO_DAEMON_PROTOCOL, DAEMON_PROTOCOL_HEADER } from "@claxedo/helpers/claxedo-daemon"
import type { AccountState } from "./account/account-service"
import type { DaemonFetch } from "./daemon-request"

const RETRY_INTERVAL_MS = 60_000
const REFRESH_LEAD_MS = 60_000
const PENDING_GRANT = "Signed desktop cleanup grant is pending"
const UNAVAILABLE_GRANT = "Signed desktop cleanup grant could not be issued"

/**
 * Main owns this grant's whole lifetime. Account credentials only travel to
 * their bound control plane; the issuer's scoped grant only travels to the
 * daemon main authenticated. Nothing depends on Host Connector enrollment or
 * a served workspace, and nothing is written to disk or returned over IPC.
 */
export function setupSessionCleanupGrantSync(input: {
  coreOrigin: string | undefined
  runAccountOperation: (name: HostedOperationName, params?: Record<string, unknown>) => Promise<unknown>
  daemon: DaemonFetch
  log: { info(message: string): void; warn(message: string): void }
  now?: () => number
  setTimer?: (run: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}) {
  const now = input.now ?? Date.now
  const setTimer = input.setTimer ?? setTimeout
  const clearTimer = input.clearTimer ?? clearTimeout
  let state: AccountState | undefined
  let epoch = 0
  let stopped = false
  let clearRequired = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let writes: Promise<void> = Promise.resolve()
  let refreshing: { epoch: number; work: Promise<void> } | undefined

  const current = (startedIn: number) => !stopped && startedIn === epoch && state?.status === "signed"
  const cancelTimer = () => {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
  }
  const schedule = (startedIn: number, delayMs: number) => {
    if (stopped || startedIn !== epoch) return
    cancelTimer()
    timer = setTimer(() => {
      timer = undefined
      void refresh()
    }, delayMs)
    timer.unref?.()
  }

  const write = (capability: unknown, startedIn?: number, unavailable?: string) => {
    const work = writes.then(async () => {
      // A state change can supersede an install while an earlier write drains.
      if (startedIn !== undefined && !current(startedIn)) return
      const response = await input.daemon("/api/claxedo/daemon/session-cleanup", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          [DAEMON_PROTOCOL_HEADER]: String(CLAXEDO_DAEMON_PROTOCOL),
        },
        body: JSON.stringify({ capability, ...(unavailable ? { unavailable } : {}) }),
        signal: AbortSignal.timeout(10_000),
      })
      // Never log or return a daemon body that might echo the capability.
      await response.body?.cancel()
      if (!response.ok) throw new Error(`daemon cleanup grant write failed (${response.status})`)
    })
    // Keep later clears usable after a failed write; withdraw/mint own the
    // returned rejection and log it at the operation that actually failed.
    writes = work.catch(() => {})
    return work
  }

  const withdraw = async (unavailable?: string) => {
    try {
      await write(null, undefined, unavailable)
      input.log.info("[session-cleanup] desktop grant withdrawn")
      return true
    } catch (error) {
      input.log.warn(`[session-cleanup] desktop grant withdrawal failed: ${String(error)}`)
      return false
    }
  }

  const clear = async (startedIn: number, unavailable?: string) => {
    const cleared = await withdraw(unavailable ?? (current(startedIn) ? PENDING_GRANT : undefined))
    if (startedIn === epoch && cleared) clearRequired = false
    return cleared
  }

  const mint = async (startedIn: number, cleared: Promise<boolean>) => {
    if (!(await cleared)) {
      schedule(startedIn, RETRY_INTERVAL_MS)
      return
    }
    if (!current(startedIn)) return
    try {
      if (!input.coreOrigin) throw new Error("no account control-plane origin configured")
      const orgId = state?.status === "signed" ? state.identity.orgId : undefined
      const answer = await input.runAccountOperation("session.cleanup.grant.desktop", orgId ? { orgId } : {})
      if (!current(startedIn)) return
      const grant = decodeHostedResult("session.cleanup.grant.desktop", answer)
      if (grant.expiresAt <= now()) throw new Error("control plane returned an expired desktop cleanup grant")
      // The issuer owns actor/org identity. Display userinfo can be a different
      // subject vocabulary, so it must not replace the issuer's actorId.
      if (orgId && grant.orgId !== orgId) throw new Error("desktop cleanup grant names another organization")
      await write({ ...grant, origin: input.coreOrigin }, startedIn)
      if (!current(startedIn)) return
      input.log.info("[session-cleanup] desktop grant installed")
      const remaining = grant.expiresAt - now()
      schedule(startedIn, Math.max(1, remaining - Math.min(REFRESH_LEAD_MS, remaining / 2)))
    } catch (error) {
      if (!current(startedIn)) return
      input.log.warn(`[session-cleanup] desktop grant refresh failed: ${String(error)}`)
      clearRequired = true
      await clear(startedIn, UNAVAILABLE_GRANT)
      schedule(startedIn, RETRY_INTERVAL_MS)
    }
  }

  const refresh = (cleared?: Promise<boolean>) => {
    if (stopped || !state) return Promise.resolve()
    if (refreshing?.epoch === epoch) return refreshing.work
    const startedIn = epoch
    const work = mint(startedIn, cleared ?? (clearRequired ? clear(startedIn) : Promise.resolve(true))).finally(() => {
      if (refreshing?.work === work) refreshing = undefined
    })
    refreshing = { epoch: startedIn, work }
    return work
  }

  return {
    follow(next: AccountState) {
      if (stopped) return
      const previous = state
      state = next
      const same = previous?.status === "signed" && next.status === "signed"
        && previous.identity.userId === next.identity.userId && previous.identity.orgId === next.identity.orgId
      if (same || (previous && previous.status !== "signed" && next.status !== "signed")) return
      epoch++
      clearRequired = true
      cancelTimer()
      // Clears immediately, independent of an old control-plane request that
      // may still be pending. Its eventual answer cannot install in this epoch.
      void refresh(clear(epoch))
    },
    refresh: () => refresh(),
    async stop() {
      if (stopped) return
      stopped = true
      epoch++
      cancelTimer()
      await withdraw()
    },
  }
}
