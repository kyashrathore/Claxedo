/**
 * The wire between a `claxedo connect` machine and its owner's desktop broker,
 * shared by both ends. The desktop dials the machine's direct listener,
 * upgrades `OWNER_BROKER_PATH` to `OWNER_BROKER_UPGRADE`, and then serves
 * HTTP/2 on that socket: the machine is the HTTP/2 client, so its model calls
 * travel back over a connection the desktop opened.
 *
 * Streams on it:
 *   GET /offer                    → `{ providers: string[] }`, the providers the desktop serves this machine
 *   <any> /providers/<id>/<path>  → that provider's vendor API through the desktop's broker
 * Each carries the machine's owner broker pass in `OWNER_BROKER_PASS_HEADER`.
 */

import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http2"
import type { Readable, Writable } from "node:stream"

export const OWNER_BROKER_PATH = "/owner-broker"
export const OWNER_BROKER_UPGRADE = "claxedo-owner-broker"
export const OWNER_BROKER_PASS_HEADER = "x-claxedo-owner-broker-pass"
export const OWNER_BROKER_OFFER_PATH = "/offer"
export const OWNER_BROKER_PROVIDER_PREFIX = "/providers/"

/** HTTP/2 refuses connection-specific fields, and a credential never crosses to the other end. */
const NOT_CARRIED = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "te", "http2-settings",
  "content-length", "authorization", "x-api-key", "x-goog-api-key", "cookie", "proxy-authorization", OWNER_BROKER_PASS_HEADER,
])

/** A request's or response's fields as the other end may receive them over the channel. */
export function carriedHeaders(headers: Headers): OutgoingHttpHeaders {
  const carried: OutgoingHttpHeaders = {}
  headers.forEach((value, name) => {
    if (!NOT_CARRIED.has(name) && !name.startsWith(":")) carried[name] = value
  })
  return carried
}

/** The fields an HTTP/2 stream received, pseudo-headers and connection fields left out. */
export function receivedHeaders(headers: IncomingHttpHeaders): Headers {
  const received = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith(":") || NOT_CARRIED.has(name)) continue
    for (const item of Array.isArray(value) ? value : [value]) received.append(name, item)
  }
  return received
}

/** A Node readable as a fetch body; the readable stays paused until the consumer pulls. */
export function streamedBody(readable: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      readable.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk))
        if ((controller.desiredSize ?? 0) <= 0) readable.pause()
      })
      readable.once("end", () => controller.close())
      readable.once("error", (error) => controller.error(error))
      readable.pause()
    },
    pull: () => {
      readable.resume()
    },
    cancel: () => {
      readable.destroy()
    },
  })
}

/** Write a fetch body to a Node writable, waiting for it to drain, and end it. */
export async function pumpBody(body: ReadableStream<Uint8Array>, writable: Writable): Promise<void> {
  const reader = body.getReader()
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    if (writable.destroyed) {
      await reader.cancel()
      return
    }
    if (!writable.write(chunk.value)) {
      await new Promise<void>((drained) => {
        const done = () => {
          writable.off("drain", done)
          writable.off("close", done)
          drained()
        }
        writable.once("drain", done)
        writable.once("close", done)
      })
    }
  }
  writable.end()
}
