import { randomUUID } from "node:crypto"
import http from "node:http"
import { readField, readRecord, readString } from "@claxedo/helpers/readers"
import { CLAXEDO_DAEMON_CAPABILITY_HEADER, createDaemonFetch } from "./daemon-request"
import {
  CLAXEDO_DAEMON_PROTOCOL,
  DAEMON_PROTOCOL_HEADER,
  type ClaxedoDaemonDiscovery,
} from "./server-daemon-discovery"

type HeldConnection = { id: string; close: () => void; closed: Promise<void> }

/**
 * Holds this process's lease on the daemon for as long as one connection stays
 * open. The daemon releases it the moment that connection closes, whether this
 * process closed it or died, so there is nothing to renew and a crashed app
 * hands the daemon to its idle grace at once.
 */
export async function holdClaxedoDaemonLease(
  discovery: ClaxedoDaemonDiscovery,
  options: {
    requestTimeoutMs?: number
    onLost?: () => void
    onError?: (error: unknown) => void
  } = {},
) {
  const request = createDaemonFetch({
    endpoint: () => ({ origin: `http://127.0.0.1:${String(discovery.port)}`, capability: discovery.token }),
  })
  const headers = {
    "x-claxedo-daemon-client": "electron-main",
    [DAEMON_PROTOCOL_HEADER]: String(CLAXEDO_DAEMON_PROTOCOL),
  }
  const requestTimeoutMs = positive(options.requestTimeoutMs, 1_500)
  let released = false
  const held = await openLease(discovery, headers, requestTimeoutMs, (error) => {
    if (!released) options.onError?.(error)
  })
  void held.closed.then(() => {
    if (!released) options.onLost?.()
  })

  async function release() {
    released = true
    held.close()
    await held.closed
  }

  return {
    get id() {
      return held.id
    },
    stop: release,
    /**
     * Releases the lease and asks the daemon to drain.
     *
     * The old `/shutdown` acknowledged a request and called that termination.
     * A drain is the honest version of the same intent: it closes the machine
     * to new work, waits for what is still running, and answers with what it
     * could not drain. The handoff grace does not apply while it holds the
     * gate, which is the one property the old call was relied on for.
     */
    async drain() {
      if (released) return
      await release()
      try {
        const inspected = await request("/api/claxedo/daemon/recovery", {
          headers,
          signal: AbortSignal.timeout(requestTimeoutMs),
        })
        if (!inspected.ok) throw new Error(`daemon drain failed (${String(inspected.status)})`)
        const machine: unknown = await inspected.json()
        const scopeRevision = readString(machine, "scopeRevision")
        // Submitting without them would ask the daemon to drain a scope it
        // never described, which it answers by refusing on the revision — a
        // refusal that reads like a race rather than an unreadable inspection.
        if (!scopeRevision || !readRecord(machine, "target")) {
          throw new Error("the daemon's recovery inspection named no machine scope to drain")
        }
        const submitted = await request("/api/claxedo/daemon/recovery", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            requestId: `electron-main-drain-${randomUUID()}`,
            action: "drain_daemon",
            target: readField(machine, "target"),
            scopeRevision,
            attempt: 1,
          }),
          signal: AbortSignal.timeout(requestTimeoutMs),
        })
        if (!submitted.ok) throw new Error(`daemon drain failed (${String(submitted.status)})`)
      } catch (error) {
        options.onError?.(error)
      }
    },
  }
}

/**
 * node:http rather than fetch: fetch ends a response body that has been silent
 * for five minutes, and this one stays silent for as long as it is held.
 */
function openLease(
  discovery: ClaxedoDaemonDiscovery,
  headers: Record<string, string>,
  timeoutMs: number,
  onConnectionError: (error: Error) => void,
) {
  return new Promise<HeldConnection>((resolve, reject) => {
    const connection = http.request({
      host: "127.0.0.1",
      port: discovery.port,
      method: "POST",
      path: "/api/claxedo/daemon/leases",
      agent: false,
      headers: {
        ...headers,
        [CLAXEDO_DAEMON_CAPABILITY_HEADER]: discovery.token,
        authorization: `Bearer ${discovery.token}`,
      },
    })
    const refuse = (error: Error) => {
      clearTimeout(deadline)
      connection.destroy()
      reject(error)
    }
    const deadline = setTimeout(() => refuse(new Error("daemon lease acquire timed out")), timeoutMs)
    connection.once("error", refuse)
    connection.once("response", (response) => {
      if (response.statusCode !== 201) {
        refuse(new Error(`daemon lease acquire failed (${String(response.statusCode)})`))
        return
      }
      const closed = new Promise<void>((done) => response.once("close", done))
      let first = ""
      response.setEncoding("utf8")
      response.on("data", function readLease(chunk: string) {
        first += chunk
        const end = first.indexOf("\n")
        if (end < 0) return
        response.off("data", readLease)
        const id = leaseId(first.slice(0, end))
        if (!id) {
          refuse(new Error("daemon returned an invalid lease"))
          return
        }
        clearTimeout(deadline)
        connection.off("error", refuse)
        connection.on("error", onConnectionError)
        resolve({ id, close: () => connection.destroy(), closed })
      })
    })
    connection.end()
  })
}

function leaseId(line: string) {
  try {
    return readString(JSON.parse(line), "id")
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

function positive(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback
}
