/**
 * The one authorized lifetime of an attached terminal, from admission to the
 * last byte.
 *
 * A terminal socket outlives the request that opened it, so the admission that
 * opened it is not evidence that the reader may still read or that the typist
 * may type. Both entrypoints that attach a client to a `Pty` — the runtime's
 * own `/:ptyID/connect` route and the local daemon's in-process proxy, which
 * cannot reach that route because its upgrade is bound to a `@hono/node-ws`
 * instance no listener serves — take their whole answer from here, so a grant
 * removed mid-socket ends the stream on both.
 *
 * Three rules the policy alone cannot state:
 *
 * - Output waits for the stream decision. `Pty.connect` replays scrollback
 *   synchronously, so connecting first and authorizing after hands the
 *   transcript to a caller who was about to be refused; a connection cannot be
 *   built without the admission it runs on.
 * - The deadline is the authority's. A lease's `expiresAt` is checked at every
 *   send, not only on the poll, so a decision that has run out cannot release a
 *   byte through a callback that resolved late.
 * - A refused write is not a refused read. A session shared for reading admits
 *   the viewer's eyes and drops their keystrokes; only the read renewal closes
 *   the socket.
 */

import { Pty } from "./index"
import { errorBody } from "../routes/error-body"
import { sessionAccessContext, type SessionAccessPolicy, type SessionAccessPolicyInput, type SessionAccessStreamDecision } from "../session-access-policy"
import { workspaceViewerRefusal } from "../routes/workspace-role"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import type { WebSocketBackpressureSocket } from "./websocket-backpressure"

/** Both entrypoints refuse a workspace viewer with this, and the router says it once more for the rest of the family. */
export const PTY_ROLE_DENIED_MESSAGE = "Workspace role does not allow terminal access"

/** How often an open stream re-checks its own deadline. */
const AUTHORIZATION_POLL_MS = 1_000
/** How long before a read deadline renewal is attempted. */
const READ_RENEW_WINDOW_MS = 5_000
/** A write lease closer to expiry than this is re-asked before the keystroke lands. */
const WRITE_RENEW_WINDOW_MS = 1_000
/**
 * After a refused write the stream refuses locally for this long instead of
 * asking again. A client that keeps typing at a session it may not drive
 * would otherwise turn every keystroke into an authority request.
 */
const WRITE_DENIAL_HOLD_MS = 1_000

export type PtyStreamSocket = WebSocketBackpressureSocket

/**
 * The caller the policy is asked about, carried whole from the boundary that
 * verified it. `credential` is the request's own proof: a remote authority
 * refuses a stream question that arrives with neither it nor a lease.
 */
export type PtyStreamAccess = Pick<SessionAccessPolicyInput, "actor" | "authority" | "credential"> & {
  method: string
  path: string
}

export type PtyAccessRefusal = { allowed: false; status: number; code: string; message: string }

export const PTY_NOT_FOUND_REFUSAL: PtyAccessRefusal = {
  allowed: false,
  status: 404,
  code: "pty_session_not_found",
  message: "Session not found",
}

const streamAuthorityUnavailable: PtyAccessRefusal = {
  allowed: false,
  status: 503,
  code: "pty_stream_authority_unavailable",
  message: "Terminal stream authority is unavailable",
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
}): PtyStreamAccess {
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

/**
 * The admission a stream runs on: the authority's own answer, with the
 * deadline it put on it. A caller with no verified authority is this machine's
 * own user and gets an admission with no deadline — no third party holds a
 * grant that could be taken from them, and inventing an expiry here would be
 * this process signing for an authority it does not have.
 */
export type PtyStreamAdmission = { allowed: true; lease?: string; expiresAt?: number }

function verifiedStreamAdmission(decision: SessionAccessStreamDecision, now: number): PtyStreamAdmission | PtyAccessRefusal {
  if (!decision.allowed) return decision
  if (!decision.lease || !Number.isFinite(decision.expiresAt) || decision.expiresAt <= now) return streamAuthorityUnavailable
  return decision
}

/**
 * Whether this caller may attach at all, answered before the upgrade so a
 * refusal is an HTTP status the client can read rather than a close code — and
 * answered ONCE, because the admission it returns is the decision the socket
 * then runs on.
 */
export async function authorizePtyAttach(input: {
  policy: SessionAccessPolicy
  access: PtyStreamAccess
  info: Pty.Info
}): Promise<PtyStreamAdmission | PtyAccessRefusal> {
  const role = workspaceViewerRefusal(input.access.authority?.role, PTY_ROLE_DENIED_MESSAGE)
  if (role) return role
  if (!input.access.authority) return { allowed: true }
  if (!input.info.sessionId) return PTY_NOT_FOUND_REFUSAL
  const request = { ...input.access, operation: "pty_read" as const, sessionId: input.info.sessionId }
  try {
    if (!input.policy.authorizeStream) {
      // The refusal this policy would give is the accurate one; an admission
      // it cannot put a deadline on is not one a terminal may run on.
      const decision = await input.policy.authorize(request)
      return decision.allowed ? streamAuthorityUnavailable : decision
    }
    const decision = await input.policy.authorizeStream(request)
    return verifiedStreamAdmission(decision, Date.now())
  } catch {
    return streamAuthorityUnavailable
  }
}

export type AuthorizedPtyConnection = {
  /** Admits the stream, then attaches it; nothing is read from the PTY before. */
  onOpen(socket: PtyStreamSocket): void
  /** Frames are delivered in arrival order, each behind its own write decision; a promised frame is awaited in place. */
  onMessage(data: unknown): void
  onClose(): void
}

export function createAuthorizedPtyConnection(input: {
  ptyId: string
  policy: SessionAccessPolicy
  access: PtyStreamAccess
  /** {@link authorizePtyAttach}'s answer: a socket cannot be built without one. */
  admission: PtyStreamAdmission
  cursor?: number
  now?: () => number
}): AuthorizedPtyConnection {
  const now = input.now ?? Date.now
  let socket: PtyStreamSocket | undefined
  let handler: ReturnType<typeof Pty.connect>
  let closed = false
  let streaming = false
  let renewing = false
  let readLease = input.admission.lease
  let readExpiresAt = input.admission.expiresAt
  let poll: ReturnType<typeof setInterval> | undefined
  let writeLease: string | undefined
  let writeExpiresAt: number | undefined
  let writeDeniedUntil = 0
  let work = Promise.resolve()

  const live = () => streaming && !closed && (readExpiresAt === undefined || now() < readExpiresAt)

  const stop = (reason: string) => {
    if (closed) return
    closed = true
    streaming = false
    if (poll) clearInterval(poll)
    poll = undefined
    handler?.onClose()
    socket?.close(1008, reason)
  }

  const authorize = async (
    operation: "pty_read" | "pty_write",
    lease?: string,
  ): Promise<PtyStreamAdmission | PtyAccessRefusal> => {
    if (!input.access.authority) return { allowed: true }
    const sessionId = Pty.get(input.ptyId)?.sessionId
    if (!sessionId) return PTY_NOT_FOUND_REFUSAL
    if (!input.policy.authorizeStream) return streamAuthorityUnavailable
    try {
      const decision = await input.policy.authorizeStream({
        ...input.access,
        operation,
        sessionId,
      }, lease)
      return verifiedStreamAdmission(decision, now())
    } catch {
      return streamAuthorityUnavailable
    }
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
    if (readExpiresAt !== undefined && now() >= readExpiresAt) {
      stop("Session access expired")
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
    if (readExpiresAt === undefined) return
    poll = setInterval(tick, AUTHORIZATION_POLL_MS)
    ;(poll as { unref?: () => void }).unref?.()
  }

  const renew = async () => {
    if (renewing) return
    renewing = true
    try {
      const decision = await authorize("pty_read", readLease)
      if (closed || !streaming) return
      if (!decision.allowed) {
        stop("Session access denied")
        return
      }
      readLease = decision.lease
      readExpiresAt = decision.expiresAt
    } finally {
      renewing = false
    }
  }

  const tick = () => {
    if (closed || !streaming || readExpiresAt === undefined) return
    if (now() >= readExpiresAt) {
      stop("Session access expired")
      return
    }
    if (now() + READ_RENEW_WINDOW_MS < readExpiresAt) return
    void renew()
  }

  const deliver = async (pending: unknown) => {
    // A binary frame may still be a Blob the host has to read; awaiting it here
    // rather than at the host keeps it behind the frames that arrived first.
    const data = await pending
    if (closed || !streaming) return
    if (!Pty.get(input.ptyId)) {
      stop("Session not found")
      return
    }
    if (!live()) {
      stop("Session access expired")
      return
    }
    if (input.access.authority) {
      if (now() < writeDeniedUntil) return
      if (writeExpiresAt === undefined || now() + WRITE_RENEW_WINDOW_MS >= writeExpiresAt) {
        const decision = await authorize("pty_write", writeLease)
        if (closed || !streaming) return
        if (!decision.allowed) {
          writeLease = undefined
          writeExpiresAt = undefined
          writeDeniedUntil = now() + WRITE_DENIAL_HOLD_MS
          return
        }
        writeLease = decision.lease
        writeExpiresAt = decision.expiresAt
      }
      // The write question was asked over the network; the read deadline may
      // have passed while it was in flight.
      if (!live()) {
        stop("Session access expired")
        return
      }
      if (writeExpiresAt === undefined || !Number.isFinite(writeExpiresAt) || now() >= writeExpiresAt) return
    }
    handler?.onMessage(data)
  }

  const queue = (task: () => Promise<void>) => {
    work = work.then(task).catch(() => stop("Session access denied"))
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
