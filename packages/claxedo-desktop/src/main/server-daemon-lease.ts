import { readNumber, readString } from "../shared/json-read"
import { createDaemonFetch } from "./daemon-request"
import type { ClaxedoDaemonDiscovery } from "./server-daemon-discovery"

export async function holdClaxedoDaemonLease(
  discovery: ClaxedoDaemonDiscovery,
  options: {
    fetch?: typeof fetch
    renewIntervalMs?: number
    retryIntervalMs?: number
    requestTimeoutMs?: number
    onError?: (error: unknown) => void
  } = {},
) {
  // The lifecycle bearer and the admission capability are the same published
  // secret under the two headers the daemon reads them from.
  const request = createDaemonFetch({
    endpoint: () => ({ origin: `http://127.0.0.1:${String(discovery.port)}`, capability: discovery.token }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
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
    const response = await request("/api/claxedo/daemon/leases", {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    if (!response.ok) throw new Error(`daemon lease acquire failed (${String(response.status)})`)
    return parseLease(await response.json())
  }

  async function renewOnce() {
    const response = await request(`/api/claxedo/daemon/leases/${encodeURIComponent(lease.id)}`, {
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

  async function halt(release: () => Promise<Response>) {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
    timer = undefined
    await operation?.catch(() => {})
    await release()
      .then((response) => {
        if (!response.ok) throw new Error(`daemon lease release failed (${String(response.status)})`)
      })
      .catch((error) => options.onError?.(error))
  }

  schedule()
  return {
    get id() {
      return lease.id
    },
    renewNow,
    async stop() {
      await halt(() => request(`/api/claxedo/daemon/leases/${encodeURIComponent(lease.id)}`, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(requestTimeoutMs),
      }))
    },
    async shutdown() {
      await halt(() => request("/api/claxedo/daemon/shutdown", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ leaseId: lease.id }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      }))
    },
  }
}

function parseLease(value: unknown) {
  const id = readString(value, "id")
  const expiresAt = readNumber(value, "expiresAt")
  if (!id || expiresAt === undefined) throw new Error("daemon returned an invalid lease")
  return { id, expiresAt }
}

function positive(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback
}
