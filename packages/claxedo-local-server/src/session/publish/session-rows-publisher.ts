import type { SessionRef } from "@claxedo/agent-runtime-contract"
import {
  MAX_HOST_SESSION_ROWS,
  type HostSessionRow,
  type HostSessionRowsResult,
  type SessionAttentionPublication,
} from "@claxedo/server-core/platform/auth/host-session-rows"
import type { HostServingPublisherCredential } from "@claxedo/host-serving/serving"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { record } from "../../platform/json"
import type { SessionRowSource } from "./local-session-rows"
import { createAttentionHistoryPublisher } from "./attention-history-publisher"
import { createSessionRowOrigins } from "./session-row-origins"

const log = Log.create({ service: "session-rows-publisher" })

export type SessionRowsPublisherOptions = {
  source: SessionRowSource
  /** The control plane's publish endpoint as the last heartbeat named it; nothing until it has. */
  url: () => string | undefined
  fetch?: typeof fetch
  random?: () => number
  debounceMs?: number
  /** The first retry delay after a failed publish; doubles per failure up to `maxRetryMs`, jittered ±50%. */
  retryMs?: number
  maxRetryMs?: number
  /** Past this many coalesced sessions the set is dropped for one full resync. */
  maxDirtySessions?: number
}

export type SessionRowsPublisher = {
  sessionChanged: (workspaceId: string, sessionId: string) => void
  sessionRemoved: (workspaceId: string, sessionId: string) => void
  /** A snapshot rewrote the workspace's rows; which ones changed is not known. */
  workspaceChanged: (workspaceId: string) => void
  /** The canonical runtime owner mounted before live presentation frames begin. */
  workspaceMounted: (workspaceId: string) => void
  /** The serving credential as it stands now, or nothing when this machine serves nothing. */
  credentialChanged: (credential: HostServingPublisherCredential | undefined) => void
  /** Republish every served workspace's rows. */
  resync: () => void
  stop: () => void
}

/** Where a publication item came from, so a failed chunk can put it back. */
type Origin = { workspaceId: string; sessionId?: string }

type Item = Origin & ({ row: HostSessionRow } | { removed: SessionRef } | { attention: SessionAttentionPublication })

type Chunk = { rows: HostSessionRow[]; removed: SessionRef[]; attention: SessionAttentionPublication[]; origins: Origin[] }

class SessionRowsUnauthorized extends Error {
  constructor() {
    super("the control plane refused the Host Tunnel Token")
    this.name = "SessionRowsUnauthorized"
  }
}

const publishedRowKey = (workspaceId: string, sessionId: string) => `${workspaceId}/${sessionId}`

function sameWorkspaceSet(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((id) => b.includes(id))
}

function sameServingAuthority(a: HostServingPublisherCredential | undefined, b: HostServingPublisherCredential | undefined) {
  return !!a && !!b && a.hostId === b.hostId && a.enrollmentId === b.enrollmentId && a.generation === b.generation
    && sameWorkspaceSet(a.workspaceIds, b.workspaceIds)
}

function chunkItems(items: Item[]): Chunk[] {
  const chunks: Chunk[] = []
  let current: Chunk = { rows: [], removed: [], attention: [], origins: [] }
  for (const item of items) {
    const incomingEvents = "attention" in item ? item.attention.events.length : 0
    if ("row" in item && current.rows.length >= MAX_HOST_SESSION_ROWS
      || "removed" in item && current.removed.length >= MAX_HOST_SESSION_ROWS
      || "attention" in item && current.attention.length >= MAX_HOST_SESSION_ROWS
      || current.attention.reduce((count, batch) => count + batch.events.length, 0) + incomingEvents > 256) {
      chunks.push(current)
      current = { rows: [], removed: [], attention: [], origins: [] }
    }
    if ("row" in item) current.rows.push(item.row)
    else if ("removed" in item) current.removed.push(item.removed)
    else current.attention.push(item.attention)
    current.origins.push({ workspaceId: item.workspaceId, ...(item.sessionId ? { sessionId: item.sessionId } : {}) })
  }
  if (current.origins.length) chunks.push(current)
  return chunks
}

function refusedKeys(result: HostSessionRowsResult) {
  return new Set(result.refused.map((refusal) => publishedRowKey(refusal.workspaceId, refusal.sessionId)))
}

/**
 * Publishes this machine's session list rows to the control plane: on change,
 * coalesced and debounced; on a changed credential or workspace set, every
 * served workspace in full. One publish in flight at a time, retried with
 * exponential backoff, and nothing scheduled while nothing is pending.
 *
 * The control plane's endpoint is idempotent and never moves a row backwards,
 * so any publish may be repeated: a failed chunk is put back rather than
 * reconciled, and an overflowed change set collapses into one full resync.
 */
export function createSessionRowsPublisher(options: SessionRowsPublisherOptions): SessionRowsPublisher {
  const attention = createAttentionHistoryPublisher(options.source)
  const origins = createSessionRowOrigins(options.source)
  const fetchImpl = options.fetch ?? fetch
  const random = options.random ?? Math.random
  const debounceMs = options.debounceMs ?? 250
  const retryMs = options.retryMs ?? 1_000
  const maxRetryMs = options.maxRetryMs ?? 60_000
  const maxDirtySessions = options.maxDirtySessions ?? 1_000

  const dirtySessions = new Map<string, SessionRef>()
  const dirtyWorkspaces = new Set<string>()
  const recoveringWorkspaces = new Set<string>()
  let resyncPending = false
  let credential: HostServingPublisherCredential | undefined
  /** Fences asynchronous reads and acknowledgements to their admitted serving authority. */
  let servingEpoch = 0
  /** The token a 401 refused; nothing is sent with it again. */
  let staleToken: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let failures = 0
  let stopped = false

  const served = (workspaceId: string) => credential?.workspaceIds.includes(workspaceId) ?? false
  const pending = () => resyncPending || dirtyWorkspaces.size > 0 || dirtySessions.size > 0

  const clearDirty = () => {
    dirtySessions.clear()
    dirtyWorkspaces.clear()
  }

  const retryDelay = () => {
    const base = Math.min(maxRetryMs, retryMs * 2 ** (failures - 1))
    return Math.round(Math.min(maxRetryMs, base * (0.5 + random())))
  }

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  const schedule = () => {
    if (stopped || timer || inFlight || !pending()) return
    if (!credential || !options.url() || staleToken === credential.token) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, failures ? retryDelay() : debounceMs)
    timer.unref?.()
  }

  const remark = (origin: Origin) => {
    if (origin.sessionId) dirtySessions.set(publishedRowKey(origin.workspaceId, origin.sessionId), { workspaceId: origin.workspaceId, sessionId: origin.sessionId })
    else dirtyWorkspaces.add(origin.workspaceId)
  }

  const collectWorkspace = async (workspaceId: string, items: Item[], active: () => boolean) => {
    await options.source.prepareWorkspace(workspaceId)
    if (!active()) return
    const rows = await options.source.listRows(workspaceId)
    if (!active()) return
    const removed = await options.source.removedRows(workspaceId)
    if (!active()) return
    for (const row of rows) {
      const history = await attention.read(row)
      if (!active()) return
      items.push({ workspaceId, sessionId: row.sessionId,
        row: { ...row, replayed: origins.replayed(row, recoveringWorkspaces.has(workspaceId)) } })
      for (const batch of history) items.push({ workspaceId, sessionId: row.sessionId, attention: batch })
    }
    for (const ref of removed) items.push({ workspaceId, removed: ref })
  }

  const collectSession = async (dirty: SessionRef, items: Item[], active: () => boolean) => {
    await options.source.prepareWorkspace(dirty.workspaceId)
    if (!active()) return
    const read = await options.source.readRow(dirty.workspaceId, dirty.sessionId)
    if (!active()) return
    if (read.kind === "row") {
      const history = await attention.read(read.row)
      if (!active()) return
      items.push({ ...dirty, row: { ...read.row, replayed: origins.replayed(read.row, recoveringWorkspaces.has(dirty.workspaceId)) } })
      for (const batch of history) items.push({ ...dirty, attention: batch })
    }
    if (read.kind === "absent") {
      const removed = await options.source.removedRows(dirty.workspaceId)
      if (!active()) return
      const ref = removed.find((ref) => ref.sessionId === dirty.sessionId)
      if (ref) items.push({ ...dirty, removed: ref })
    }
  }

  /** Reads what a full or partial publish has to say; a workspace or session that cannot be read stays dirty. */
  const collect = async (workspaceIds: readonly string[], active: () => boolean): Promise<{ full: boolean; items: Item[]; unreadable: number; recovered: string[] } | undefined> => {
    const items: Item[] = []
    const recovered: string[] = []
    let unreadable = 0
    const full = resyncPending
    const workspaces = new Set(full ? workspaceIds : dirtyWorkspaces)
    const sessions = full ? [] : [...dirtySessions.values()].filter((dirty) => !workspaces.has(dirty.workspaceId))
    resyncPending = false
    clearDirty()
    for (const workspaceId of workspaces) {
      try {
        await collectWorkspace(workspaceId, items, active)
        if (!active()) return undefined
        recovered.push(workspaceId)
      } catch (error) {
        if (!active()) return undefined
        dirtyWorkspaces.add(workspaceId)
        unreadable += 1
        log.warn("session rows unreadable for workspace", { workspaceId, error: String(error) })
      }
    }
    for (const dirty of sessions) {
      try {
        await collectSession(dirty, items, active)
        if (!active()) return undefined
      } catch (error) {
        if (!active()) return undefined
        remark(dirty)
        unreadable += 1
        log.warn("session row unreadable", { ...dirty, error: String(error) })
      }
    }
    return { full, items, unreadable, recovered }
  }

  const post = async (url: string, token: string, hostId: string, chunk: Chunk) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ hostId, rows: chunk.rows, removed: chunk.removed, attention: chunk.attention }),
    })
    if (response.status === 401) throw new SessionRowsUnauthorized()
    if (!response.ok) throw new Error(`control plane answered ${response.status}`)
    const body = record(await response.json().catch(() => undefined))
    const accepted = body?.accepted
    const refused = body?.refused
    const named = new Set([...chunk.rows, ...chunk.removed].map((ref) => publishedRowKey(ref.workspaceId, ref.sessionId)))
    const expected = chunk.rows.length + chunk.removed.length + chunk.attention.filter((ref) => !named.has(publishedRowKey(ref.workspaceId, ref.sessionId))).length
    if (typeof accepted !== "number" || !Number.isSafeInteger(accepted) || accepted < 0 || !Array.isArray(refused)
      || accepted + refused.length !== expected) throw new Error("Invalid session rows acknowledgement")
    const checked: HostSessionRowsResult["refused"] = []
    for (const refusal of refused) {
      const ref = record(refusal)
      if (!ref || typeof ref.workspaceId !== "string" || typeof ref.sessionId !== "string"
        || (ref.reason !== "workspace_not_served" && ref.reason !== "session_elsewhere" && ref.reason !== "session_deleted")) {
        throw new Error("Invalid session row refusal")
      }
      checked.push({ workspaceId: ref.workspaceId, sessionId: ref.sessionId, reason: ref.reason })
    }
    return { accepted, refused: checked }
  }

  const acknowledge = (chunk: Chunk, result: HostSessionRowsResult) => {
    const refused = refusedKeys(result)
    for (const batch of chunk.attention) {
      if (!refused.has(publishedRowKey(batch.workspaceId, batch.sessionId))) attention.acknowledge(batch)
    }
    for (const ref of chunk.removed) attention.forget(ref.workspaceId, ref.sessionId)
    if (result.refused.length) log.info("control plane refused session rows", { refused: result.refused })
  }

  const flush = async () => {
    const url = options.url()
    const current = credential
    if (inFlight || stopped || !url || !current || staleToken === current.token) return
    const epoch = servingEpoch
    const active = () => !stopped && servingEpoch === epoch
    inFlight = true
    let full = resyncPending
    const unsent: Chunk[] = []
    try {
      const collected = await collect(current.workspaceIds, active)
      if (!collected || !active()) return
      full = collected.full
      unsent.push(...chunkItems(collected.items))
      while (unsent.length) {
        const chunk = unsent[0]
        const result = await post(url, current.token, current.hostId, chunk)
        if (!active()) return
        acknowledge(chunk, result)
        unsent.shift()
      }
      for (const workspaceId of collected.recovered) recoveringWorkspaces.delete(workspaceId)
      // What could not be read is dirty again and is retried on the same
      // backoff as a failed post; only a flush that read and sent everything
      // returns to the debounce.
      failures = collected.unreadable ? failures + 1 : 0
    } catch (error) {
      if (!active()) return
      if (full) resyncPending = true
      else for (const chunk of unsent) chunk.origins.forEach(remark)
      if (error instanceof SessionRowsUnauthorized) {
        staleToken = current.token
        resyncPending = true
        log.warn("session rows refused; waiting for the next serving credential", { hostId: current.hostId })
      } else {
        failures += 1
        log.warn("session rows publish failed", { failures, error: String(error) })
      }
    } finally {
      inFlight = false
      schedule()
    }
  }

  const markSession = (workspaceId: string, sessionId: string) => {
    if (!served(workspaceId)) return
    origins.live(workspaceId, sessionId)
    dirtySessions.set(publishedRowKey(workspaceId, sessionId), { workspaceId, sessionId })
    if (dirtySessions.size > maxDirtySessions) {
      clearDirty()
      resyncPending = true
    }
    schedule()
  }

  return {
    sessionChanged: markSession,
    sessionRemoved: markSession,
    workspaceChanged: (workspaceId) => {
      if (!served(workspaceId)) return
      dirtyWorkspaces.add(workspaceId)
      schedule()
    },
    workspaceMounted: (workspaceId) => {
      if (!served(workspaceId)) return
      origins.recover(workspaceId)
      recoveringWorkspaces.add(workspaceId)
      dirtyWorkspaces.add(workspaceId)
      schedule()
    },
    resync: () => {
      clearDirty()
      resyncPending = true
      schedule()
    },
    credentialChanged: (next) => {
      const previous = credential
      credential = next
      const authorityChanged = !sameServingAuthority(previous, next)
      if (authorityChanged) {
        servingEpoch += 1
        attention.reset()
        origins.reset()
      }
      if (staleToken !== undefined && staleToken !== next?.token) staleToken = undefined
      if (!next) {
        clearTimer()
        clearDirty()
        resyncPending = true
        return
      }
      if (authorityChanged) {
        for (const workspaceId of next.workspaceIds) {
          origins.recover(workspaceId)
          if (!previous || previous.hostId !== next.hostId || previous.enrollmentId !== next.enrollmentId
            || previous.generation !== next.generation || !previous.workspaceIds.includes(workspaceId)) recoveringWorkspaces.add(workspaceId)
        }
        clearDirty()
        resyncPending = true
      }
      schedule()
    },
    stop: () => {
      stopped = true
      clearTimer()
    },
  }
}
