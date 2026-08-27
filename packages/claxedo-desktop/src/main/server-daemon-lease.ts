import type { ClaxedoDaemonDiscovery } from "./server-daemon-discovery"

type RequestFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export async function holdClaxedoDaemonLease(
  discovery: ClaxedoDaemonDiscovery,
  options: {
    request?: RequestFn
    renewIntervalMs?: number
    retryIntervalMs?: number
    requestTimeoutMs?: number
    onError?: (error: unknown) => void
  } = {},
) {
  const request = options.request ?? fetch
  const base = `http://127.0.0.1:${String(discovery.port)}`
  const headers = {
    authorization: `Bearer ${discovery.token}`,
    "x-claxedo-daemon-client": "electron-main",
  }
  const renewIntervalMs = positive(options.renewIntervalMs, 5_000)
  const retryIntervalMs = positive(options.retryIntervalMs, 1_000)
  const requestTimeoutMs = positive(options.requestTimeoutMs, 1_500)
  let lease = await acquire()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let operation: Promise<void> | undefined

  function schedule(delayMs = renewIntervalMs) {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void renewNow(), delayMs)
    timer.unref?.()
  }

  async function acquire() {
    const response = await request(`${base}/api/claxedo/daemon/leases`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    if (!response.ok) throw new Error(`daemon lease acquire failed (${String(response.status)})`)
    return parseLease(await response.json())
  }

  async function renewOnce() {
    const response = await request(`${base}/api/claxedo/daemon/leases/${encodeURIComponent(lease.id)}`, {
      method: "PUT",
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    if (response.ok) {
      lease = parseLease(await response.json())
      schedule()
      return
    }
    // An expired lease is not patched back into existence. Acquire a new
    // generation-scoped lease while the daemon's idle grace is still open.
    lease = await acquire()
    schedule()
  }

  function renewNow() {
    if (stopped) return Promise.resolve()
    if (operation) return operation
    operation = renewOnce()
      .catch((error) => {
        options.onError?.(error)
        schedule(retryIntervalMs)
      })
      .finally(() => {
        operation = undefined
      })
    return operation
  }

  schedule()
  return {
    get id() {
      return lease.id
    },
    renewNow,
    async stop() {
      if (stopped) return
      stopped = true
      if (timer) clearTimeout(timer)
      timer = undefined
      await operation?.catch(() => {})
      await request(`${base}/api/claxedo/daemon/leases/${encodeURIComponent(lease.id)}`, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(requestTimeoutMs),
      }).catch((error) => options.onError?.(error))
    },
  }
}

function parseLease(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("daemon returned an invalid lease")
  const lease = value as Record<string, unknown>
  if (typeof lease.id !== "string" || !lease.id || typeof lease.expiresAt !== "number" || !Number.isFinite(lease.expiresAt)) {
    throw new Error("daemon returned an invalid lease")
  }
  return { id: lease.id, expiresAt: lease.expiresAt }
}

function positive(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback
}
