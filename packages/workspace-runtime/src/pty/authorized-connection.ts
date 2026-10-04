/**
 * The one authorized lifetime of an attached terminal, from admission to the
 * last byte.
 *
 * A terminal socket outlives the request that opened it, so the admission that
 * opened it is not evidence that the caller may still read or type. Both
 * entrypoints that attach a client to a `Pty` — the runtime's own
 * `/:ptyID/connect` route and the local daemon's in-process proxy, which
 * cannot reach that route because its upgrade is bound to a `@hono/node-ws`
 * instance no listener serves — take their whole answer from here, so a
 * revoked workspace token ends the stream on both.
 *
 * Two rules the authority alone cannot state:
 *
 * - Output waits for the stream decision. `Pty.connect` replays scrollback
 *   synchronously, so connecting first and authorizing after hands the
 *   transcript to a caller who was about to be refused; a connection cannot be
 *   built without the admission `admitTerminal` answered before the upgrade.
 * - The deadline is the authority's. A lease's `expiresAt` is checked at every
 *   send and every keystroke, not only on the poll, so a decision that has run
 *   out cannot release a byte through a callback that resolved late.
 */

import { Pty } from "./index"
import { errorBody, sessionAccessContext, type SessionAccessPolicy } from "@claxedo/session-core"
import type { RelayHostAuthContext } from "@claxedo/session-core/relay-host"
import type { WebSocketBackpressureSocket } from "./websocket-backpressure"
import {
  authorizeTerminal,
  terminalLease,
  type PtyAccessRefusal,
  type TerminalAccess,
  type TerminalAdmission,
} from "./terminal-authority"

/** How often an open stream re-checks its own deadline. */
const AUTHORIZATION_POLL_MS = 1_000
/** How long before a read deadline renewal is attempted. */
const READ_RENEW_WINDOW_MS = 5_000

export type PtyStreamSocket = WebSocketBackpressureSocket

export const PTY_NOT_FOUND_REFUSAL: PtyAccessRefusal = {
  allowed: false,
  status: 404,
  code: "pty_session_not_found",
  message: "Session not found",
}

export function ptyAccessRefusalResponse(refusal: PtyAccessRefusal) {
  return Response.json(errorBody(refusal.code, refusal.message), { status: refusal.status })
}

export function isPtyStreamSocket(value: unknown): value is PtyStreamSocket {
  if (!value || typeof value !== "object") return false
  if (typeof (value as { readyState?: unknown }).readyState !== "number") return false
  if (typeof (value as { send?: unknown }).send !== "function") return false
  return typeof (value as { close?: unknown }).close === "function"
}

/**
 * What a verified relay stamp means to this policy, or the local owner's
 * absence of one — read through the same translator the runtime's own routes
 * use, so an in-process attach cannot present an identity an HTTP request
 * could not.
 */
export function ptyStreamAccess(input: {
  identity?: RelayHostAuthContext["relayHostAuth"]
  authorization?: string
  method: string
  path: string
}): TerminalAccess {
  const context = sessionAccessContext({
    get: () => input.identity,
    req: { header: (name) => (name === "authorization" ? input.authorization : undefined) },
  })
  return {
    ...(context.actor ? { actor: context.actor } : {}),
    ...(context.authority ? { authority: context.authority } : {}),
    ...(context.credential ? { credential: context.credential } : {}),
    method: input.method,
    path: input.path,
  }
}

export type AuthorizedPtyConnection = {
  /** Admits the stream, then attaches it; nothing is read from the PTY before. */
  onOpen(socket: PtyStreamSocket): void
  /** Frames are delivered in arrival order; a promised frame is awaited in place. */
  onMessage(data: unknown): void
  onClose(): void
}

export function createAuthorizedPtyConnection(input: {
  ptyId: string
  policy: SessionAccessPolicy
  access: TerminalAccess
  admission: TerminalAdmission
  cursor?: number
  now?: () => number
}): AuthorizedPtyConnection {
  const now = input.now ?? Date.now
  let socket: PtyStreamSocket | undefined
  let handler: ReturnType<typeof Pty.connect>
  let closed = false
  let streaming = false
  let renewing = false
  let lease = input.admission.lease
  let expiresAt = input.admission.expiresAt
  let poll: ReturnType<typeof setInterval> | undefined
  let work = Promise.resolve()

  const live = () => streaming && !closed && (expiresAt === undefined || now() < expiresAt)

  const stop = (reason: string) => {
    if (closed) return
    closed = true
    streaming = false
    if (poll) clearInterval(poll)
    poll = undefined
    handler?.onClose()
    socket?.close(1008, reason)
  }

  const gated: PtyStreamSocket = {
    get readyState() {
      return live() ? socket?.readyState ?? 3 : 3
    },
    get bufferedAmount() {
      return socket?.bufferedAmount
    },
    send(data) {
      if (live() && socket?.readyState === 1) socket.send(data)
    },
    close(code, reason) {
      socket?.close(code, reason)
    },
  }

  const attach = async () => {
    if (closed) return
    if (expiresAt !== undefined && now() >= expiresAt) {
      stop("Terminal access expired")
      return
    }
    streaming = true
    handler = Pty.connect(input.ptyId, gated, input.cursor)
    if (!handler) {
      // `Pty.connect` has already closed the socket — an unknown terminal or a
      // replay this client could not take.
      streaming = false
      closed = true
      return
    }
    if (expiresAt === undefined) return
    poll = setInterval(tick, AUTHORIZATION_POLL_MS)
    ;(poll as { unref?: () => void }).unref?.()
  }

  const renew = async () => {
    if (renewing) return
    renewing = true
    try {
      const decision = terminalLease(await authorizeTerminal(input.policy, input.access, lease), now())
      if (closed || !streaming) return
      if (!decision.allowed) {
        stop("Terminal access denied")
        return
      }
      lease = decision.lease
      expiresAt = decision.expiresAt
    } finally {
      renewing = false
    }
  }

  const tick = () => {
    if (closed || !streaming || expiresAt === undefined) return
    if (now() >= expiresAt) {
      stop("Terminal access expired")
      return
    }
    if (now() + READ_RENEW_WINDOW_MS < expiresAt) return
    void renew()
  }

  const deliver = async (pending: unknown) => {
    // A binary frame may still be a Blob the host has to read; awaiting it here
    // rather than at the host keeps it behind the frames that arrived first.
    const data = await pending
    if (closed || !streaming) return
    if (!Pty.get(input.ptyId)) {
      stop("Terminal not found")
      return
    }
    if (!live()) {
      stop("Terminal access expired")
      return
    }
    handler?.onMessage(data)
  }

  const queue = (task: () => Promise<void>) => {
    work = work.then(task).catch(() => stop("Terminal access denied"))
  }

  return {
    onOpen(next) {
      socket = next
      queue(attach)
    },
    onMessage(data) {
      queue(() => deliver(data))
    },
    onClose() {
      // Marked before the queue drains, so a task still waiting on the
      // authority cannot attach or feed a socket the client has left.
      closed = true
      streaming = false
      if (poll) clearInterval(poll)
      poll = undefined
      handler?.onClose()
    },
  }
}
