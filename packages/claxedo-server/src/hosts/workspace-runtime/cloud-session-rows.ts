import type { AgentEventEnvelope, SessionRef } from "@claxedo/agent-runtime-contract"
import type { HostSessionRow, SessionAttentionPublication } from "@claxedo/server-core/platform/auth/host-session-rows"
import type { CloudSessionRowsResult } from "@claxedo/server-core/platform/auth/cloud-session-rows"
import { createSessionPublicationOrigins } from "@claxedo/server-core/session/publication-origin"
import { asRecord } from "@claxedo/helpers/guards"
import { eventSessionId } from "@claxedo/session-core"
import type { WorkspaceRuntimeServerOptions } from "@claxedo/workspace-runtime"
import { cloudSessionRow } from "./cloud-session-row"
import type { CloudSessionRowsGrant, CloudSessionRowsFetch } from "./cloud-session-rows-grant"

type Inventory = Parameters<NonNullable<WorkspaceRuntimeServerOptions["bindSessionInventory"]>>[0]
type Publication = { rows: HostSessionRow[]; removed: SessionRef[]; attention: SessionAttentionPublication[] }
type Cursor = { generation: number; through: number }

const ROW_EVENTS = new Set([
  "session.created", "session.updated", "session.deleted", "session.status", "session.idle", "session.error", "session.background-work",
  "message.completed", "permission.asked", "permission.replied", "permission.expired",
  "question.asked", "question.replied", "question.rejected", "question.expired",
])

/** Sends committed rows and replays the runtime's durable attention history after every restart. */
export function cloudSessionRows(input: {
  workspaceId: string
  url: string
  grant: CloudSessionRowsGrant
  fetch?: CloudSessionRowsFetch
  retryMs?: number
  reconcileMs?: number
  warn?: (message: string, details: Record<string, unknown>) => void
}) {
  const send = input.fetch ?? fetch
  const warn = input.warn ?? (() => {})
  const dirty = new Map<string, number>()
  const removed = new Set<string>()
  const sent = new Map<string, number>()
  const cursors = new Map<string, Cursor>()
  const publicationOrigins = createSessionPublicationOrigins()
  let inventory: Inventory | undefined
  let version = 0
  let stopped = false
  let draining = false
  let processed = 0
  let responses = 0
  let pending: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let reconcileTimer: ReturnType<typeof setInterval> | undefined

  function mark(sessionId: string) { dirty.set(sessionId, ++version) }
  function markLive(sessionId: string) {
    const session = inventory?.session(sessionId)
    const row = session && cloudSessionRow(session, input.workspaceId)
    if (row) publicationOrigins.remember(row, row.attention!, false)
    mark(sessionId)
  }
  function schedule(delay = 0) {
    if (stopped || draining || timer) return
    timer = setTimeout(() => { timer = undefined; void flush() }, delay)
    timer.unref?.()
  }

  function reconcile() {
    if (!inventory || stopped) return
    for (const session of inventory.sessions()) {
      const row = cloudSessionRow(session, input.workspaceId)
      if (row) { removed.delete(session.id); publicationOrigins.remember(row, row.attention!, true) }
      if (row && sent.get(session.id) !== row.attention!.sequence) mark(session.id)
    }
    for (const sessionId of inventory.removed()) {
      if (removed.has(sessionId)) continue
      removed.add(sessionId)
      mark(sessionId)
    }
    if (dirty.size) schedule()
  }

  function publication(snapshot: ReadonlyMap<string, number>) {
    const body: Publication = { rows: [], removed: [], attention: [] }
    const progress = new Map<string, Cursor>()
    const ignored = new Set<string>()
    for (const sessionId of snapshot.keys()) {
      const session = inventory!.session(sessionId)
      if (!session) {
        if (removed.has(sessionId)) body.removed.push({ sessionId, workspaceId: input.workspaceId })
        else throw new Error(`Session ${sessionId} vanished without a committed removal`)
        continue
      }
      const row = cloudSessionRow(session, input.workspaceId)
      if (!row) { ignored.add(sessionId); continue }
      removed.delete(sessionId)
      body.rows.push({ ...row, replayed: publicationOrigins.remember(row, row.attention!, true) })
      const previous = cursors.get(sessionId)
      const after = previous?.generation === row.attention!.generation ? previous.through : 0
      const page = inventory!.attention(sessionId, after, 256)
      const through = page.next ?? page.through
      body.attention.push({ sessionId, workspaceId: input.workspaceId, generation: page.generation, through, events: page.events })
      progress.set(sessionId, { generation: page.generation, through })
    }
    return { body, progress, ignored }
  }

  async function publish() {
    if (!inventory || stopped || dirty.size === 0) return
    const snapshot = new Map([...dirty].slice(0, 4))
    const { body, progress, ignored } = publication(snapshot)
    if (body.rows.length + body.removed.length === 0) {
      for (const sessionId of ignored) if (dirty.get(sessionId) === snapshot.get(sessionId)) {
        dirty.delete(sessionId)
        processed++
      }
      return
    }
    const token = await input.grant.token()
    if (!token) throw new Error("Cloud session producer proof is unavailable")
    const response = await send(input.url, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Cloud session rows refused (${response.status})`)
    const result = publicationResult(await response.json())
    for (const ref of result.refused) {
      if (ref.workspaceId !== input.workspaceId || !snapshot.has(ref.sessionId)) {
        throw new Error("Cloud session row acknowledgement names a session outside its publication")
      }
    }
    const refusals = new Map(result.refused.map((ref) => [ref.sessionId, ref.reason]))
    if (result.accepted + result.refused.length !== body.rows.length + body.removed.length + body.attention.length) {
      throw new Error("Cloud session row acknowledgement does not cover its publication")
    }
    responses++
    for (const [sessionId, revision] of snapshot) {
      if (ignored.has(sessionId)) {
        if (dirty.get(sessionId) === revision) { dirty.delete(sessionId); processed++ }
        continue
      }
      const refusal = refusals.get(sessionId)
      if (refusal && !(removed.has(sessionId) && refusal === "session_deleted")) {
        warn("session_rows.refused", { sessionId, reason: refusal })
        const queued = dirty.get(sessionId)
        if (queued !== undefined) { dirty.delete(sessionId); dirty.set(sessionId, queued) }
        continue
      }
      const cursor = progress.get(sessionId)
      if (cursor) cursors.set(sessionId, cursor)
      processed++
      const row = body.rows.find((value) => value.sessionId === sessionId)
      if (row) sent.set(sessionId, row.attention!.sequence)
      if (row && cursor && cursor.through < row.attention!.sequence) mark(sessionId)
      else if (dirty.get(sessionId) === revision) dirty.delete(sessionId)
    }
  }

  async function flush() {
    if (pending) return pending
    pending = publish().catch((error: unknown) => {
      warn("session_rows.publish_failed", { error: String(error) })
    }).finally(() => {
      pending = undefined
      if (dirty.size) schedule(input.retryMs ?? 1_000)
    })
    return pending
  }

  return {
    bindSessionInventory(read: Inventory) {
      inventory = read
      try { reconcile() } catch (error) { warn("session_rows.inventory_failed", { error: String(error) }) }
      reconcileTimer = setInterval(() => {
        try { reconcile() } catch (error) { warn("session_rows.inventory_failed", { error: String(error) }) }
      }, input.reconcileMs ?? 60_000)
      reconcileTimer.unref?.()
    },
    onPresentationEvent(event: AgentEventEnvelope) {
      if (!ROW_EVENTS.has(event.payload.type)) return
      const sessionId = eventSessionId(event.payload)
      if (!sessionId) return
      if (event.payload.type === "session.deleted") {
        if (!inventory?.removed().includes(sessionId)) return
        removed.add(sessionId)
      }
      markLive(sessionId)
      schedule()
    },
    onTurnOutcome(event: { sessionId: string }) { markLive(event.sessionId); schedule() },
    flush,
    async drain() {
      draining = true
      if (timer) clearTimeout(timer)
      if (reconcileTimer) clearInterval(reconcileTimer)
      await pending
      try { reconcile() } catch (error) { warn("session_rows.inventory_failed", { error: String(error) }) }
      const deadline = Date.now() + 10_000
      const stalled = new Set<string>()
      while (dirty.size && Date.now() < deadline) {
        const before = processed
        const received = responses
        const attempted = [...dirty.keys()].slice(0, 4)
        await flush()
        if (processed > before) { stalled.clear(); continue }
        if (responses === received) break
        for (const sessionId of attempted) stalled.add(sessionId)
        if ([...dirty.keys()].every((sessionId) => stalled.has(sessionId))) break
      }
      stopped = true
      if (timer) clearTimeout(timer)
      input.grant.stop()
    },
  }
}

function publicationResult(input: unknown): CloudSessionRowsResult {
  const row = asRecord(input)
  if (!row || typeof row.accepted !== "number" || !Number.isSafeInteger(row.accepted) || row.accepted < 0 || !Array.isArray(row.refused)) {
    throw new Error("Cloud session row acknowledgement is invalid")
  }
  const refused: CloudSessionRowsResult["refused"] = []
  for (const value of row.refused) {
    const refusal = asRecord(value)
    if (typeof refusal?.workspaceId !== "string" || typeof refusal.sessionId !== "string" || (refusal.reason !== "workspace_not_served" && refusal.reason !== "session_elsewhere" && refusal.reason !== "session_deleted" && refusal.reason !== "session_unregistered" && refusal.reason !== "attention_boundary_changed")) {
      throw new Error("Cloud session row refusal is invalid")
    }
    refused.push({ workspaceId: refusal.workspaceId, sessionId: refusal.sessionId, reason: refusal.reason })
  }
  return { accepted: row.accepted, refused }
}
