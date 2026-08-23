import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"

export function bindEngineWorkerRequestAbort(incoming: IncomingMessage, outgoing: ServerResponse) {
  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("Engine worker client disconnected", "AbortError"))
    }
  }
  const incomingClose = () => {
    if (incoming.aborted || !incoming.complete) abort()
  }
  const outgoingClose = () => {
    if (!outgoing.writableEnded) abort()
  }
  incoming.once("aborted", abort)
  incoming.once("close", incomingClose)
  outgoing.once("close", outgoingClose)
  return {
    signal: controller.signal,
    dispose() {
      incoming.removeListener("aborted", abort)
      incoming.removeListener("close", incomingClose)
      outgoing.removeListener("close", outgoingClose)
    },
  }
}

export function isAuthorizedEngineWorkerRequest(header: string | string[] | undefined, token: string) {
  if (typeof header !== "string") return false
  const actual = Buffer.from(header)
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function sessionStatusHasActiveWork(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return true
  return Object.values(input).some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return true
    return (value as { type?: unknown }).type !== "idle"
  })
}
