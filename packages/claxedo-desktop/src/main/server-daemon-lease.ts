import http from "node:http"
import { readString } from "@claxedo/helpers/readers"
import { CLAXEDO_DAEMON_CAPABILITY_HEADER } from "./daemon-request"
import { CLAXEDO_DAEMON_PROTOCOL, DAEMON_PROTOCOL_HEADER } from "@claxedo/helpers/claxedo-daemon"
import type { ClaxedoDaemonDiscovery } from "./server-daemon-discovery"

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
