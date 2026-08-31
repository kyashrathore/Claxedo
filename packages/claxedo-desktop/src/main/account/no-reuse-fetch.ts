/**
 * Control-plane fetch without connection reuse.
 *
 * Live Cloudflare deployments can poison a keep-alive socket: requests written
 * to it stop arriving at the Worker entirely while the connection itself stays
 * "usable". Node's pooled fetch then deals every retry onto another warm —
 * equally poisoned — socket, and the desktop's steady polling keeps those
 * sockets alive indefinitely, so the app never recovers while a freshly
 * connected curl succeeds immediately. (Observed live 2026-08-31: the app's
 * stalled reads produced no Worker invocations at all while parallel
 * fresh-connection probes returned 200 in under a second; full audit trail in
 * docs/handoffs/cloudflare-multiplayer-migration.md.)
 *
 * `agent: false` gives every request its own connection and closes it after
 * the response, which is exactly the behavior every successful probe used.
 * Control-plane traffic is low-rate, so the extra handshake is an acceptable
 * price for removing the poisoned-pool failure class outright.
 */

import { request as httpsRequest } from "node:https"
import { request as httpRequest } from "node:http"
import type { IncomingMessage } from "node:http"
import { Readable } from "node:stream"

const BODYLESS_STATUS = new Set([204, 205, 304])

function toResponse(incoming: IncomingMessage, method: string): Response {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry)
    else headers.set(name, value)
  }
  const status = incoming.statusCode ?? 0
  const bodyless = method === "HEAD" || BODYLESS_STATUS.has(status)
  if (bodyless) incoming.resume()
  return new Response(bodyless ? null : (Readable.toWeb(incoming) as ReadableStream), {
    status,
    statusText: incoming.statusMessage ?? "",
    headers,
  })
}

/** `fetch`-shaped, one fresh connection per request, closed afterwards. */
export async function noConnectionReuseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const normalized = new Request(input, init)
  const url = new URL(normalized.url)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`no-reuse fetch supports only http(s), got ${url.protocol}`)
  }
  const body = normalized.body ? Buffer.from(await normalized.arrayBuffer()) : undefined
  const headers: Record<string, string> = {}
  normalized.headers.forEach((value, name) => {
    headers[name] = value
  })
  // Explicit, not implied by agent:false: the peer must not keep this socket.
  headers.connection = "close"
  const request = url.protocol === "https:" ? httpsRequest : httpRequest
  const signal = normalized.signal
  return await new Promise<Response>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: normalized.method,
        headers,
        // The point of this module: never a pooled or kept-alive socket.
        agent: false,
      },
      (incoming) => {
        try {
          resolve(toResponse(incoming, normalized.method))
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      },
    )
    // Wired by hand rather than the request `signal` option so cancellation
    // also destroys the socket mid-response (ending a streamed body read).
    const abort = () => {
      const reason = signal.reason instanceof Error ? signal.reason : new Error("request aborted")
      reject(reason)
      outgoing.destroy(reason)
    }
    if (signal.aborted) abort()
    else {
      signal.addEventListener("abort", abort, { once: true })
      outgoing.on("close", () => signal.removeEventListener("abort", abort))
    }
    outgoing.on("error", (error) => reject(new Error(`fetch failed: ${String(error)}`, { cause: error })))
    outgoing.end(body)
  })
}
