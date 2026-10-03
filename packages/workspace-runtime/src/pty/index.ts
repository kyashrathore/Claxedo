import { timingSafeEqualStrings } from "@claxedo/helpers"
import { Log } from "../log"
import { DEFAULT_RECOVERY_BUDGETS } from "@claxedo/agent-runtime-contract"
import {
  captureDescendants,
  captureOwnedGroup,
  launchErrorText,
  readCreationIdentity,
  retire,
  retireDescendants,
  retirementSettled,
  type LaunchOwnershipStore,
  type RetirementResult,
} from "@claxedo/process-ownership/launch"
import { osc7 as osc7Parser } from "./osc7"
import { enqueueWrite, flushWriteQueue } from "./write-queue"
import { decodeInput } from "./decode-input"
import { terminalIo } from "./io-clock"
import { sendWebSocketWithBackpressure, type WebSocketBackpressureSocket } from "./websocket-backpressure"
import { safeChunkEnd } from "./safe-slice"
import { type ModeTracker } from "./mode-tracker"
import { sanitizeReplay } from "./replay-sanitize"

import * as contracts from "./session-types"
import type { ActiveSession } from "./session-types"
import { startTerminal } from "./session-start"
export { selectPtyCommand } from "./session-start"

export namespace Pty {
  export const Info = contracts.Info
  export type Info = contracts.Info
  export const CreateInput = contracts.CreateInput
  export type CreateInput = contracts.CreateInput
  export const UpdateInput = contracts.UpdateInput
  export type UpdateInput = contracts.UpdateInput
  export const Event = contracts.Event
  export type AgentHookAccessBinding = contracts.AgentHookAccessBinding
  const log = Log.create({ service: "pty" })

  /**
   * ## Per-session memory contract
   *
   * Everything a live PTY holds in RAM is bounded here. Total server-side
   * terminal memory is therefore (sessions × the sum below), and the session
   * count is itself bounded by orphan reaping (see `orphanTimeoutMs`).
   *
   *   BUFFER_LIMIT          2 MB code units  — the replay buffer, ~2–4 MB heap
   *   QUEUE_HIGH_WATERMARK  1 MB             — pending writes to a slow pty
   *   modeTracker                            — headless xterm, 5000 scrollback rows
   *                                            + up to 1 MB pending control string
   *
   * History is not in this list: it lives only on disk (see history-disk.ts),
   * never mirrored in RAM — mirroring it would cost HISTORY_LIMIT, 16 MB per
   * terminal, for data already durable and read at most once per session
   * lifetime.
   */
  const BUFFER_LIMIT = 1024 * 1024 * 2
  const WEBSOCKET_BUFFERED_AMOUNT_MAX = (() => {
    const raw = Number(process.env.CLAXEDO_PTY_WS_BUFFERED_AMOUNT_MAX)
    if (!Number.isFinite(raw) || raw <= 0) return 1024 * 1024
    return Math.floor(raw)
  })()
  const BUFFER_CHUNK = 64 * 1024
  const QUEUE_HIGH_WATERMARK = (() => {
    const raw = Number(process.env.CLAXEDO_PTY_QUEUE_HIGH_WATERMARK)
    if (!Number.isFinite(raw) || raw <= 0) return 1024 * 1024
    return Math.floor(raw)
  })()
  const QUEUE_LOW_WATERMARK = (() => {
    const raw = Number(process.env.CLAXEDO_PTY_QUEUE_LOW_WATERMARK)
    if (!Number.isFinite(raw) || raw <= 0) return 256 * 1024
    return Math.floor(raw)
  })()
  const orphanTimeoutMs = () => {
    const raw = Number(process.env.CLAXEDO_PTY_ORPHAN_TIMEOUT_MS)
    if (!Number.isFinite(raw) || raw <= 0) return 60_000
    return Math.floor(raw)
  }
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const meta = (cursor: number, checkpoint?: ReturnType<ModeTracker["checkpoint"]>) => {
    const json = JSON.stringify({ cursor, ...(checkpoint ? { checkpoint } : {}) })
    const bytes = encoder.encode(json)
    const out = new Uint8Array(bytes.length + 1)
    out[0] = 0
    out.set(bytes, 1)
    return out
  }

  export const osc7 = osc7Parser

  function safeReplay(ws: WebSocketBackpressureSocket, replay: string) {
    if (!replay) return true
    try {
      let i = 0
      while (i < replay.length) {
        // A fixed-stride slice can end between the halves of a surrogate pair,
        // which makes the outgoing text frame invalid UTF-8. Escapes split
        // across sends are fine — xterm reassembles them across writes.
        const end = safeChunkEnd(replay, Math.min(replay.length, i + BUFFER_CHUNK))
        // Degenerate guard: a pair straddling the very first boundary would
        // otherwise pin `end` at `i` and spin forever.
        const stop = end > i ? end : Math.min(replay.length, i + BUFFER_CHUNK)
        if (!sendWebSocketWithBackpressure(ws, replay.slice(i, stop), {
          maxBufferedBytes: WEBSOCKET_BUFFERED_AMOUNT_MAX,
        })) {
          return false
        }
        i = stop
      }
      return true
    } catch {
      return false
    }
  }

  function safeBroadcast(session: ActiveSession, data: string | Uint8Array) {
    for (const ws of session.subscribers) {
      if (ws.readyState !== 1) {
        session.subscribers.delete(ws)
        continue
      }
      if (!sendWebSocketWithBackpressure(ws, data, { maxBufferedBytes: WEBSOCKET_BUFFERED_AMOUNT_MAX })) {
        session.subscribers.delete(ws)
      }
    }
  }

  /**
   * A terminal's own session and process group come from the PTY itself
   * (`forkpty` calls `setsid`), so the scope this retires is the one the OS
   * already gave it. What it cannot see is a descendant that left that group.
   */
  async function retireSession(id: string, session: ActiveSession, closeNative: () => void): Promise<RetirementResult> {
    if (!session.identity) {
      closeNative()
      if (await leaderVanished(session)) return { leader: "exited", descendants: "unknown", signals: [] }
      return {
        leader: "unknown",
        descendants: "unknown",
        signals: [],
        error: {
          code: "ownership_unverified",
          message: `terminal ${id} has no recorded creation identity, so its process group cannot be signalled`,
        },
      }
    }
    // Captured while the leader is alive: once it exits, a descendant that left
    // the group is reparented and nothing connects it to this terminal any more.
    const escapees = await captureDescendants(session.identity.pid).catch(() => [])
    const result = await retire({ identity: session.identity, closeNative }, DEFAULT_RECOVERY_BUDGETS)
    session.escapees = await retireDescendants(
      escapees.filter((candidate) => candidate.processGroupId !== session.identity!.processGroupId),
      DEFAULT_RECOVERY_BUDGETS,
    )
    await persistRetirement(id, session, result)
    return result
  }

  /**
   * A payload that exits before its identity is read (a `/bin/echo`) leaves
   * nothing to verify, but the PTY library reaping it
   * or its pid no longer existing is proof that the leader is gone. A pid that
   * still answers may be a reuse, so it stays unverifiable rather than exited.
   */
  async function leaderVanished(session: ActiveSession) {
    if (session.exited) return true
    const pid = session.info.pid
    if (!(pid > 0)) return false
    try {
      return (await readCreationIdentity(pid)) === undefined
    } catch {
      return false
    }
  }

  /**
   * A retirement nothing recorded leaves the durable row claiming a launch
   * that is over, which a later owner will try to reconcile against processes
   * that are already gone.
   */
  async function persistRetirement(id: string, session: ActiveSession, result: RetirementResult) {
    if (!session.launchId || !session.store) return
    try {
      await session.store.recordRetirement(session.launchId, result)
      session.persistence = undefined
      session.persistenceError = undefined
    } catch (error) {
      session.persistence = "unavailable"
      session.persistenceError = launchErrorText(error)
      log.error("PTY retirement could not be recorded", { id, error: session.persistenceError })
    }
  }

  /**
   * Whether this terminal must stay addressable: either its processes were
   * never proven gone, or the record that says they are is not written yet.
   */
  function retained(session: ActiveSession) {
    return session.cleanup === "unresolved" || session.persistence === "unavailable"
  }

  function clearOrphanTimer(session: ActiveSession) {
    if (!session.orphanTimer) return
    clearTimeout(session.orphanTimer)
    session.orphanTimer = undefined
  }

  function armOrphanTimer(id: string, session: ActiveSession) {
    if (session.committed || session.exited || session.removed || session.orphanTimer) return
    const timeoutMs = orphanTimeoutMs()
    log.info("provisional PTY cleanup timer started", { id, timeoutMs })
    session.orphanTimer = setTimeout(() => {
      const current = sessions.get(id)
      if (!current) return
      current.orphanTimer = undefined
      if (current.committed || current.subscribers.size > 0 || current.exited || current.removed) return
      log.info("provisional PTY cleanup timer fired", { id })
      void remove(id)
    }, timeoutMs)
    session.orphanTimer.unref?.()
  }

  function cleanupSession(id: string, session: ActiveSession, reason: "exit" | "remove") {
    session.cleanupOperation ??= cleanupSessionOwned(id, session, reason)
    return session.cleanupOperation
  }

  async function cleanupSessionOwned(id: string, session: ActiveSession, reason: "exit" | "remove"): Promise<RetirementResult | undefined> {
    if (session.removed) return session.cleanupResult
    // Claim explicit removal before the asynchronous process-tree sweep. This
    // makes cleanup single-owner when a provisional timer, dispose(), and the
    // native exit callback race each other.
    if (reason === "remove") {
      session.removed = true
      activityChanged()
    }

    // Release the headless emulator on BOTH paths — it holds a parser and a
    // screen buffer per session, so leaking one per terminal adds up.
    session.modeTracker.dispose()

    clearOrphanTimer(session)

    if (reason === "exit") {
      // The shell is already gone, so the ppid edges that named its children
      // are gone with it — but a child does not leave its process group by
      // outliving its parent, and each one is identity-checked before it is
      // signalled. A backgrounded dev server is exactly this case.
      if (session.identity) {
        const members = await captureOwnedGroup(session.identity.processGroupId, session.identity.pid).catch(() => [])
        session.escapees = await retireDescendants(members, DEFAULT_RECOVERY_BUDGETS)
        await persistRetirement(id, session, { leader: "exited", descendants: "unknown", signals: [] })
      }
      await session.history.close()

      for (const ws of session.subscribers) {
        ws.close()
      }
      session.subscribers.clear()

      // unref'd: an exited session's retention sweep must not hold the
      // process open — a runtime (or test runner) with nothing else left to
      // do should exit instead of idling out this timer.
      setTimeout(() => {
        if (sessions.get(id) === session) {
          for (const ws of session.subscribers) {
            ws.close()
          }
          session.subscribers.clear()
          sessions.delete(id)
          session.removed = true
          activityChanged()
        }
      }, 1000 * 60).unref?.()
      return session.cleanupResult
    }

    session.ready = false
    for (const ws of session.subscribers) {
      ws.close()
    }
    session.subscribers.clear()
    session.writeQueue = []
    session.queuedBytes = 0
    // The native PTY owns the process even when the platform cannot expose a
    // usable OS pid (the Windows ConPTY wrapper reports 0 in that case).
    // Always close it through its native handle; the PID-based tree sweep is
    // additional cleanup only when a real pid is available.
    const closeNative = () => { try { session.process.kill() } catch {} }
    const result = await retireSession(id, session, closeNative)
    session.cleanupResult = result
    await session.history.close()
    if (!retirementSettled(result) || session.persistence === "unavailable") {
      // The processes this terminal started may still be running, so the entry
      // stays: it carries the only identity that can reach them, and dropping
      // it would report a stopped terminal over a live one.
      if (!retirementSettled(result)) session.cleanup = "unresolved"
      session.removed = false
      session.cleanupOperation = undefined
      activityChanged()
      log.error("PTY retirement unresolved", { id, pid: session.info.pid, result })
      return result
    }
    session.cleanup = undefined
    sessions.delete(id)
    activityChanged()
    return result
  }

  const sessions = new Map<string, ActiveSession>()
  const activityListeners = new Set<() => void>()

  function activityChanged() {
    for (const listener of activityListeners) listener()
  }

  /**
   * Called synchronously after every change to what `activity()` and
   * `listDetailed()` report: a terminal created, exited, removed, retained
   * unresolved, or let go. A listener must not create or remove a terminal.
   */
  export function onActivityChange(listener: () => void): () => void {
    activityListeners.add(listener)
    return () => {
      activityListeners.delete(listener)
    }
  }

  export function list() {
    return Array.from(sessions.values()).map((s) => s.info)
  }

  export function listDetailed() {
    return Array.from(sessions.values()).map((s) => ({
      ...s.info,
      subscribers: s.subscribers.size,
      ready: s.ready,
      exited: s.exited,
      removed: s.removed,
      committed: s.committed,
      orphanTimerActive: !!s.orphanTimer,
      ...(s.cleanup ? { cleanup: s.cleanup, cleanupResult: s.cleanupResult } : {}),
      ...(s.ownership ? { ownership: s.ownership, ownershipError: s.ownershipError } : {}),
      ...(s.persistence ? { persistence: s.persistence, persistenceError: s.persistenceError } : {}),
      ...(s.escapees ? { escapees: s.escapees } : {}),
    }))
  }

  /**
   * What this module is holding the runtime open for.
   *
   * `unrecorded` and `unresolved` are both counted inside `running`; they are
   * reported separately so a drain preview can name why a daemon will not
   * exit. They are different facts: an unresolved terminal has processes
   * nothing proved were gone, an unrecorded one has a process no durable
   * record will ever find again.
   */
  export function activity() {
    let running = 0
    let committed = 0
    let provisional = 0
    let subscribers = 0
    let unrecorded = 0
    let unresolved = 0
    for (const session of sessions.values()) {
      // An unresolved terminal still pins the runtime: its processes were never
      // proven gone, and a daemon that exits here abandons them. So does one
      // whose spawn was never recorded — nothing would ever find it again.
      const pinnedUnresolved = session.cleanup === "unresolved"
      const pinnedUnrecorded = session.ownership === "unrecorded" && !session.exited
      if (!pinnedUnresolved && !pinnedUnrecorded && (session.removed || session.exited || session.info.status !== "running")) continue
      running++
      if (pinnedUnresolved) unresolved++
      if (pinnedUnrecorded) unrecorded++
      subscribers += session.subscribers.size
      if (session.committed) committed++
      else provisional++
    }
    return { running, committed, provisional, subscribers, unrecorded, unresolved }
  }

  export function commit(id: string) {
    const session = sessions.get(id)
    if (!session || session.removed || session.exited) return undefined
    session.committed = true
    clearOrphanTimer(session)
    return session.info
  }

  export function get(id: string) {
    return sessions.get(id)?.info
  }

  /** Bind access only after the public route has created the PTY itself. */
  export function bindAccessOwner(id: string, actorId: string) {
    const session = sessions.get(id)
    if (!session || session.removed) return false
    if (session.accessOwnerActorId && session.accessOwnerActorId !== actorId) return false
    session.accessOwnerActorId = actorId
    return true
  }

  export function accessOwner(id: string) {
    return sessions.get(id)?.accessOwnerActorId
  }

  export function agentHookAccessForToken(token: string) {
    if (!token) return undefined
    for (const [terminalId, session] of sessions) {
      if (session.exited || session.removed) continue
      const binding = session.agentHookAccess
      if (!binding || !timingSafeEqualStrings(binding.token, token)) continue
      return { terminalId, ...binding }
    }
    return undefined
  }

  export function renewAgentHookAccess(token: string, lease: { authorityLease: string; authorityExpiresAt: number }) {
    for (const session of sessions.values()) {
      if (session.exited || session.removed) continue
      const binding = session.agentHookAccess
      if (!binding || !timingSafeEqualStrings(binding.token, token)) continue
      binding.authorityLease = lease.authorityLease
      binding.authorityExpiresAt = lease.authorityExpiresAt
      return true
    }
    return false
  }

  export function agentHookToken(id: string) {
    const session = sessions.get(id)
    if (!session || session.exited || session.removed) return undefined
    return session.agentHookAccess?.token
  }

  export function snapshot(id: string, max = BUFFER_LIMIT) {
    const session = sessions.get(id)
    if (!session) return ""
    const cap = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : BUFFER_LIMIT
    if (cap <= 0) return ""
    if (session.buffer.length <= cap) return session.buffer
    return session.buffer.slice(-cap)
  }

  export function create(input: CreateInput, ownership: LaunchOwnershipStore, agentHookAccess?: AgentHookAccessBinding, options: { platform?: NodeJS.Platform } = {}) {
    return startTerminal(input, ownership, agentHookAccess, options.platform ?? process.platform, {
      bufferLimit: BUFFER_LIMIT,
      highWatermark: QUEUE_HIGH_WATERMARK,
      lowWatermark: QUEUE_LOW_WATERMARK,
      register(session) {
        sessions.set(session.info.id, session)
        activityChanged()
        armOrphanTimer(session.info.id, session)
      },
      broadcast: safeBroadcast,
      checkpoint(session) {
        const checkpoint = session.modeTracker.checkpoint()
        checkpoint.screen = session.modeTracker.buildPreamble() + checkpoint.screen
        safeBroadcast(session, meta(session.cursor, checkpoint))
      },
      async exited(session, exitCode) {
        session.exited = true
        session.info.status = "exited"
        activityChanged()
        const id = session.info.id
        log.info("session exited", { id, exitCode })
        const tail = snapshot(id, 16_384)
        const event = { id, ...(session.info.sessionId ? { sessionId: session.info.sessionId } : {}), exitCode, tail }
        session.bus.publish({ type: "pty.exited", ...event })
        session.bus.publish({ type: "pty.stream", kind: "exit", ...event })
        await cleanupSession(session.info.id, session, "exit")
      },
    })
  }

  export async function update(id: string, input: UpdateInput) {
    const session = sessions.get(id)
    if (!session) return undefined
    if (input.title) {
      session.info.title = input.title
    }
    if (input.size) {
      resize(id, input.size.cols, input.size.rows)
    }
    session.bus.publish({ type: "pty.updated", info: session.info })
    return session.info
  }

  /**
   * Answers with what retirement established. A call on a terminal whose
   * previous removal was unresolved retries it, with the same recorded
   * identity and whatever the last attempt already achieved.
   */
  export async function remove(id: string): Promise<RetirementResult | undefined> {
    const session = sessions.get(id)
    if (!session) return undefined
    session.removeOperation ??= (async () => {
      log.info("removing session", { id })
      const result = await cleanupSession(id, session, "remove")
      if (retained(session)) return result
      // Native exit cleanup may already own `cleanupOperation`. Explicit
      // remove still owns the stronger public contract: after it resolves the
      // session must no longer be addressable, rather than waiting for exit
      // retention.
      if (sessions.get(id) === session) {
        session.removed = true
        sessions.delete(id)
        activityChanged()
      }
      session.bus.publish({
        type: "pty.deleted",
        id,
        ...(session.info.sessionId ? { sessionId: session.info.sessionId } : {}),
      })
      return result
    })()
    const result = await session.removeOperation
    if (retained(session)) session.removeOperation = undefined
    return result
  }

  /**
   * Stops tracking a terminal whose retirement never resolved. The durable
   * ownership row stays open: this is a named operator accepting that its
   * processes are unaccounted for, not evidence that they stopped, so the
   * authorization is required and recorded.
   */
  export async function abandon(id: string, authorization: { actorId: string; reason: string }) {
    const session = sessions.get(id)
    if (!session || (session.cleanup !== "unresolved" && session.persistence !== "unavailable")) return undefined
    if (!authorization.actorId || !authorization.reason) {
      throw new Error(`Abandoning terminal ${id} needs an actor and a reason: it releases a pin over processes nothing proved had stopped`)
    }
    // One last attempt at the record, so an operator does not have to accept a
    // durable row that is merely stale as well as one that is unresolved.
    if (session.cleanupResult) await persistRetirement(id, session, session.cleanupResult)
    session.removed = true
    sessions.delete(id)
    activityChanged()
    log.error("PTY ownership abandoned with cleanup unresolved", {
      id,
      ...authorization,
      result: session.cleanupResult,
      persistence: session.persistence,
    })
    return session.cleanupResult
  }

  /**
   * Retires every terminal and lets go of all of them.
   *
   * An unresolved one is reported, never discarded — but it is not kept here.
   * This map is process-local and about to be garbage; the durable ownership
   * row is what carries an unresolved launch to the next owner, and
   * `reconcileLaunchOwnership` reads that, not this. Holding a dead entry
   * after disposal only pins a runtime that is already gone.
   */
  export async function dispose(): Promise<Array<{ id: string; retirement: RetirementResult | undefined }>> {
    const results: Array<{ id: string; retirement: RetirementResult | undefined }> = []
    for (const id of Array.from(sessions.keys())) {
      results.push({ id, retirement: await remove(id) })
    }
    for (const [id, session] of Array.from(sessions.entries())) {
      log.error("PTY disposal let go of a terminal it could not retire", {
        id,
        cleanup: session.cleanup,
        persistence: session.persistence,
        result: session.cleanupResult,
      })
      session.removed = true
      sessions.delete(id)
      activityChanged()
    }
    return results
  }

  export function resize(id: string, cols: number, rows: number) {
    const session = sessions.get(id)
    if (session && session.info.status === "running") {
      enqueueWrite(session, { type: "resize", cols, rows })
      flushWriteQueue(session)
    }
  }

  export function write(id: string, data: string) {
    const session = sessions.get(id)
    if (session && session.info.status === "running") {
      if (!session.ready) {
        enqueueWrite(session, { type: "write", data })
        return
      }
      terminalIo.touch()
      session.process.write(data)
    }
  }

  export function connect(id: string, ws: WebSocketBackpressureSocket, cursor?: number) {
    const session = sessions.get(id)
    if (!session) {
      ws.close(1008, "Session not found")
      return undefined
    }
    session.subscribers.add(ws)

    clearOrphanTimer(session)

    const start = session.bufferCursor
    const end = session.cursor

    const from =
      cursor === -1 ? end : typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0
    const data = (() => {
      if (!session.buffer) return ""
      if (from >= end) return ""
      const offset = Math.max(0, from - start)
      if (offset >= session.buffer.length) return ""
      // A replay is a RECORDING. Queries in it would make the reattaching
      // terminal answer a program that asked minutes ago — and if that program
      // has exited, the shell now reading the pty echoes the reply as typed
      // input. Mode sets in it would re-arm mouse/focus/kitty for a program
      // that may be gone. Modes come from the live preamble below instead.
      return sanitizeReplay(session.buffer.slice(offset))
    })()

    // Mode preamble FIRST, from live emulator state. Mode-setting escapes are
    // emitted once at program startup and broadcast away rather than buffered,
    // so a fresh xterm needs them re-asserted on every attach — even when the
    // replay itself is empty (a live-tail reconnect to a running TUI).
    const preamble = session.modeTracker.buildPreamble()
    let replaySent: boolean
    try {
      if (from === 0) {
        const checkpoint = session.modeTracker.checkpoint()
        checkpoint.screen = preamble + checkpoint.screen
        replaySent = sendWebSocketWithBackpressure(ws, meta(end, checkpoint), { maxBufferedBytes: WEBSOCKET_BUFFERED_AMOUNT_MAX })
      } else {
        replaySent = safeReplay(ws, preamble + data)
          && sendWebSocketWithBackpressure(ws, meta(end), { maxBufferedBytes: WEBSOCKET_BUFFERED_AMOUNT_MAX })
      }
    } catch (error) {
      log.warn("pty checkpoint failed", { id, error: String(error) })
      replaySent = false
    }
    if (!replaySent) {
      session.subscribers.delete(ws)
      session.bus.publish({
        type: "pty.stream",
        id,
        ...(session.info.sessionId ? { sessionId: session.info.sessionId } : {}),
        kind: "error",
        message: "replay_send_failed",
      })
      ws.close()
      return undefined
    }

    session.ready = true
    flushWriteQueue(session)

    return {
      onMessage: (message: unknown) => {
        const input = decodeInput(message, decoder)
        if (!input) {
          return
        }
        if (session.info.status !== "running") {
          return
        }
        terminalIo.touch()
        session.process.write(input)
      },
      onClose: () => {
        log.info("client disconnected from session", { id })
        session.subscribers.delete(ws)
        session.bus.publish({
          type: "pty.stream",
          id,
          ...(session.info.sessionId ? { sessionId: session.info.sessionId } : {}),
          kind: "disconnect",
        })
        if (session.subscribers.size === 0) {
          session.ready = false
          armOrphanTimer(id, session)
        }
      },
    }
  }
}
