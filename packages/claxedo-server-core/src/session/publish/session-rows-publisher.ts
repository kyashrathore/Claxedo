import type { SessionRef } from "@claxedo/agent-runtime-contract"
import {
  MAX_HOST_SESSION_ROWS,
  type HostSessionRow,
  type HostSessionRowsResult,
} from "../../platform/auth/host-session-rows"
import { Log } from "../../platform/runtime/lib/log"
import { jsonRecord as record } from "../../platform/runtime/lib/json"

const log = Log.create({ service: "session-rows-publisher" })

export type SessionRowRead =
  | { kind: "row"; row: HostSessionRow }
  /** No root session by that id in that workspace any more. */
  | { kind: "absent" }
  /** A child session, which is never a list entry of its own. */
  | { kind: "child" }

export type SessionRowSource = {
  /** Every root session of the workspace, archived ones included, with the status its runtime holds now. */
  listRows: (workspaceId: string) => Promise<HostSessionRow[]>
  readRow: (workspaceId: string, sessionId: string) => Promise<SessionRowRead>
}

/** The bearer a publication is sent with, the host it names, and the workspaces it may publish. */
export type SessionRowsCredential = {
  hostId: string
  token: string
  workspaceIds: readonly string[]
}

export type SessionRowsPublisherOptions = {
  source: SessionRowSource
  /** The control plane's publish endpoint; nothing until the host knows it. */
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
  /** The publishing credential as it stands now, or nothing when this host may publish nothing. */
  credentialChanged: (credential: SessionRowsCredential | undefined) => void
  /** Republish every workspace the credential names. */
  resync: () => void
  /** Sends what is pending now, without waiting out the debounce or a retry, and settles once that publish has. */
  flush: () => Promise<void>
  stop: () => void
}

/** Where a publication item came from, so a failed chunk can put it back. */
type Origin = { workspaceId: string; sessionId?: string }

type Item = Origin & ({ row: HostSessionRow } | { removed: SessionRef })

type Chunk = { rows: HostSessionRow[]; removed: SessionRef[]; origins: Origin[] }

class SessionRowsUnauthorized extends Error {
  constructor() {
    super("the control plane refused the publishing credential")
    this.name = "SessionRowsUnauthorized"
  }
}

const publishedRowKey = (workspaceId: string, sessionId: string) => `${workspaceId}/${sessionId}`

function sameWorkspaceSet(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((id) => b.includes(id))
}

function chunkItems(items: Item[]): Chunk[] {
  const chunks: Chunk[] = []
  let current: Chunk = { rows: [], removed: [], origins: [] }
  for (const item of items) {
    if (current.rows.length >= MAX_HOST_SESSION_ROWS || current.removed.length >= MAX_HOST_SESSION_ROWS) {
      chunks.push(current)
      current = { rows: [], removed: [], origins: [] }
    }
    if ("row" in item) current.rows.push(item.row)
    else current.removed.push(item.removed)
    current.origins.push({ workspaceId: item.workspaceId, ...(item.sessionId ? { sessionId: item.sessionId } : {}) })
  }
  if (current.origins.length) chunks.push(current)
  return chunks
}

function refusedKeys(result: HostSessionRowsResult) {
  return new Set(result.refused.map((refusal) => publishedRowKey(refusal.workspaceId, refusal.sessionId)))
}

/**
 * Publishes a host's session list rows to the control plane: on change,
 * coalesced and debounced; on a changed credential host or workspace set,
 * every workspace the credential names in full. One publish in flight at a time, retried with
 * exponential backoff, and nothing scheduled while nothing is pending.
 *
 * The control plane's endpoint is idempotent and never moves a row backwards,
 * so any publish may be repeated: a failed chunk is put back rather than
 * reconciled, and an overflowed change set collapses into one full resync.
 */
export function createSessionRowsPublisher(options: SessionRowsPublisherOptions): SessionRowsPublisher {
  const fetchImpl = options.fetch ?? fetch
  const random = options.random ?? Math.random
  const debounceMs = options.debounceMs ?? 250
  const retryMs = options.retryMs ?? 1_000
  const maxRetryMs = options.maxRetryMs ?? 60_000
  const maxDirtySessions = options.maxDirtySessions ?? 1_000

  const dirtySessions = new Map<string, SessionRef>()
  const dirtyWorkspaces = new Set<string>()
  let resyncPending = false
  /** Session ids the control plane holds for each workspace, as far as this process has told it. */
  const published = new Map<string, Set<string>>()
  let credential: SessionRowsCredential | undefined
  /** The token a 401 refused; nothing is sent with it again. */
  let staleToken: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let running: Promise<void> | undefined
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
      void publish()
    }, failures ? retryDelay() : debounceMs)
    timer.unref?.()
  }

  const remark = (origin: Origin) => {
    if (origin.sessionId) dirtySessions.set(publishedRowKey(origin.workspaceId, origin.sessionId), { workspaceId: origin.workspaceId, sessionId: origin.sessionId })
    else dirtyWorkspaces.add(origin.workspaceId)
  }

  const collectWorkspace = async (workspaceId: string, items: Item[]) => {
    const rows = await options.source.listRows(workspaceId)
    const listed = new Set(rows.map((row) => row.sessionId))
    for (const row of rows) items.push({ workspaceId, row })
    for (const sessionId of published.get(workspaceId) ?? []) {
      if (!listed.has(sessionId)) items.push({ workspaceId, removed: { workspaceId, sessionId } })
    }
  }

  const collectSession = async (dirty: SessionRef, items: Item[]) => {
    const read = await options.source.readRow(dirty.workspaceId, dirty.sessionId)
    if (read.kind === "row") items.push({ ...dirty, row: read.row })
    if (read.kind === "absent") items.push({ ...dirty, removed: { workspaceId: dirty.workspaceId, sessionId: dirty.sessionId } })
  }

  /** Reads what a full or partial publish has to say; a workspace or session that cannot be read stays dirty. */
  const collect = async (workspaceIds: readonly string[]) => {
    const items: Item[] = []
    let unreadable = 0
    const full = resyncPending
    const workspaces = new Set(full ? workspaceIds : dirtyWorkspaces)
    const sessions = full ? [] : [...dirtySessions.values()].filter((dirty) => !workspaces.has(dirty.workspaceId))
    resyncPending = false
    clearDirty()
    for (const workspaceId of workspaces) {
      try {
        await collectWorkspace(workspaceId, items)
      } catch (error) {
        dirtyWorkspaces.add(workspaceId)
        unreadable += 1
        log.warn("session rows unreadable for workspace", { workspaceId, error: String(error) })
      }
    }
    for (const dirty of sessions) {
      try {
        await collectSession(dirty, items)
      } catch (error) {
        remark(dirty)
        unreadable += 1
        log.warn("session row unreadable", { ...dirty, error: String(error) })
      }
    }
    return { full, items, unreadable }
  }

  const post = async (url: string, token: string, hostId: string, chunk: Chunk) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ hostId, rows: chunk.rows, removed: chunk.removed }),
    })
    if (response.status === 401) throw new SessionRowsUnauthorized()
    if (!response.ok) throw new Error(`control plane answered ${response.status}`)
    const body = record(await response.json().catch(() => undefined))
    const refused = Array.isArray(body?.refused) ? body.refused : []
    return { accepted: Number(body?.accepted ?? 0), refused } as HostSessionRowsResult
  }

  const remember = (chunk: Chunk, result: HostSessionRowsResult) => {
    const refused = refusedKeys(result)
    for (const row of chunk.rows) {
      if (refused.has(publishedRowKey(row.workspaceId, row.sessionId))) continue
      const ids = published.get(row.workspaceId) ?? new Set<string>()
      ids.add(row.sessionId)
      published.set(row.workspaceId, ids)
    }
    for (const ref of chunk.removed) published.get(ref.workspaceId)?.delete(ref.sessionId)
    if (result.refused.length) log.info("control plane refused session rows", { refused: result.refused })
  }

  const flush = async () => {
    const url = options.url()
    const current = credential
    if (inFlight || stopped || !url || !current || staleToken === current.token) return
    inFlight = true
    let full = resyncPending
    const unsent: Chunk[] = []
    try {
      const collected = await collect(current.workspaceIds)
      full = collected.full
      unsent.push(...chunkItems(collected.items))
      while (unsent.length) {
        const chunk = unsent[0]
        remember(chunk, await post(url, current.token, current.hostId, chunk))
        unsent.shift()
      }
      // What could not be read is dirty again and is retried on the same
      // backoff as a failed post; only a flush that read and sent everything
      // returns to the debounce.
      failures = collected.unreadable ? failures + 1 : 0
    } catch (error) {
      if (full) resyncPending = true
      else for (const chunk of unsent) chunk.origins.forEach(remark)
      if (error instanceof SessionRowsUnauthorized) {
        staleToken = current.token
        resyncPending = true
        log.warn("session rows refused; waiting for the next publishing credential", { hostId: current.hostId })
      } else {
        failures += 1
        log.warn("session rows publish failed", { failures, error: String(error) })
      }
    } finally {
      inFlight = false
      schedule()
    }
  }

  const publish = () => {
    running = flush().finally(() => {
      running = undefined
    })
    return running
  }

  const markSession = (workspaceId: string, sessionId: string) => {
    if (!served(workspaceId)) return
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
    resync: () => {
      clearDirty()
      resyncPending = true
      schedule()
    },
    credentialChanged: (next) => {
      const previous = credential
      credential = next
      if (staleToken !== undefined && staleToken !== next?.token) staleToken = undefined
      if (!next) {
        clearTimer()
        clearDirty()
        resyncPending = true
        published.clear()
        return
      }
      if (!previous || previous.hostId !== next.hostId || !sameWorkspaceSet(previous.workspaceIds, next.workspaceIds)) {
        for (const workspaceId of published.keys()) {
          if (!next.workspaceIds.includes(workspaceId)) published.delete(workspaceId)
        }
        clearDirty()
        resyncPending = true
      }
      schedule()
    },
    flush: async () => {
      await running
      if (!pending()) return
      clearTimer()
      await publish()
    },
    stop: () => {
      stopped = true
      clearTimer()
    },
  }
}
