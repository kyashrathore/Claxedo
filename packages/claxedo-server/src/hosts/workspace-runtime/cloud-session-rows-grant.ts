import { asRecord } from "@claxedo/helpers/guards"

export type CloudSessionRowsFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type CloudSessionRowsGrant = {
  token(): Promise<string | undefined>
  stop(): void
}

/** The producer's own renewable proof; its authority never comes from a reader's bearer. */
export function cloudSessionRowsGrant(input: {
  token: string
  expiresAt: number
  renewUrl: string
  fetch?: CloudSessionRowsFetch
  now?: () => number
  warn?: (message: string, details: Record<string, unknown>) => void
}): CloudSessionRowsGrant {
  const now = input.now ?? Date.now
  const send = input.fetch ?? fetch
  let token = input.token
  let expiresAt = input.expiresAt
  let stopped = false
  let withdrawn = false
  let retryMs = 2_000
  let renewing: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const warn = input.warn ?? (() => {})

  function schedule(delay: number) {
    if (timer) clearTimeout(timer)
    if (stopped) return
    timer = setTimeout(() => { timer = undefined; void renew() }, delay)
    timer.unref?.()
  }

  async function attempt() {
    if (stopped || withdrawn) return
    try {
      const response = await send(input.renewUrl, {
        method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
      })
      if (response.status === 401 || response.status === 403) {
        withdrawn = true
        warn("session_rows.proof_withdrawn", { status: response.status })
        return
      }
      if (!response.ok) throw new Error(`Cloud session producer renewal refused (${response.status})`)
      const body = asRecord(await response.json())
      if (typeof body?.token !== "string" || !body.token || typeof body.expiresAt !== "number" || body.expiresAt <= now()) {
        throw new Error("Cloud session producer renewal has no live proof")
      }
      token = body.token
      expiresAt = body.expiresAt
      retryMs = 2_000
      schedule(Math.max(1, (expiresAt - now()) / 2))
    } catch (error) {
      warn("session_rows.renewal_failed", { error: String(error) })
      schedule(retryMs)
      retryMs = Math.min(60_000, retryMs * 2)
    }
  }

  async function renew() {
    if (renewing) return renewing
    renewing = attempt().finally(() => { renewing = undefined })
    return renewing
  }

  schedule(Math.max(1, (expiresAt - now()) / 2))
  return {
    async token() {
      if (stopped || withdrawn) return undefined
      if (expiresAt - now() < 30_000) await renew()
      return !stopped && !withdrawn && expiresAt > now() ? token : undefined
    },
    stop() { stopped = true; if (timer) clearTimeout(timer) },
  }
}
