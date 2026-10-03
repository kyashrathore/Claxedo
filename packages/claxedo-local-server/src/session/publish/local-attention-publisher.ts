import type { SessionAttentionPage } from "@claxedo/agent-runtime-contract"
import type { HostSessionRow } from "@claxedo/server-core/platform/auth/host-session-rows"
import type { SessionProjectionStore } from "@claxedo/server-core/authority/session-projection"
import { controlBus } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { SessionStateEvent } from "@claxedo/server-core/platform/runtime/lib/session-state-events"
import { appendLocalSessionAttention, localSessionAttentionPosition } from "@claxedo/server-core/session/attention-ledger"
import type { SessionRowSource } from "./local-session-rows"

type Options = {
  source: SessionRowSource
  projection: Pick<SessionProjectionStore, "session_meta">
  workspaceIds: () => Promise<string[]>
  publish?: (notice: SessionStateEvent) => void
  onError?: (error: unknown, workspaceId: string, sessionId?: string) => void
}

export function createLocalSessionAttentionPublisher(options: Options) {
  const publish = options.publish ?? ((notice) => controlBus.publish(notice))
  const queued = new Map<string, Promise<void>>()
  const retries = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingInitialWorkspaces = new Set<string>()
  const signatures = new Map<string, string>()
  let stopped = false
  let started: Promise<void> | undefined
  let initialWorkspacesKnown = false
  const keyOf = (workspaceId: string, sessionId: string) => JSON.stringify([workspaceId, sessionId])

  function retry(key: string, work: () => Promise<void>) {
    if (stopped || retries.has(key)) return
    retries.set(key, setTimeout(() => {
      retries.delete(key)
      void work().catch(() => {})
    }, 1_000))
  }

  function enqueue(workspaceId: string, sessionId: string, work: () => Promise<void>) {
    const key = keyOf(workspaceId, sessionId)
    const task = (queued.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (stopped) return
      try {
        await work()
        const timer = retries.get(key)
        if (timer) clearTimeout(timer)
        retries.delete(key)
      } catch (error) {
        options.onError?.(error, workspaceId, sessionId)
        if (!options.onError) console.error("Local session attention publication failed", { workspaceId, sessionId, error })
        retry(key, () => sessionChanged(workspaceId, sessionId))
        throw error
      }
    })
    queued.set(key, task)
    void task.finally(() => { if (queued.get(key) === task) queued.delete(key) }).catch(() => {})
    return task
  }

  async function publishRow(row: HostSessionRow, replayed: boolean) {
    if (!row.attention) throw new Error(`Session ${row.sessionId} has no canonical activity facts`)
    const meta = await options.projection.session_meta(row.sessionId)
    if (!meta || meta.parentID || meta.workspaceID !== row.workspaceId) return
    if (!meta.sessionRef || !meta.projectID) throw new Error("Session attention requires canonical project and session refs")
    const key = keyOf(row.workspaceId, row.sessionId)
    const base = { workspaceId: row.workspaceId, sessionId: row.sessionId, projectId: meta.projectID,
      ...(row.title ? { title: row.title } : {}), ...(replayed ? { replayed: true } : {}) }
    let after = localSessionAttentionPosition(meta.sessionRef, row.attention.generation)
    while (after < row.attention.sequence) {
      if (stopped) return
      const page = await options.source.attentionPage(row.workspaceId, row.sessionId, after)
      if (page.generation !== row.attention.generation) throw new Error("Session generation changed during attention publication")
      validateHistoryPage(page, after)
      const through = Math.min(page.next ?? page.through, row.attention.sequence)
      if (through <= after) throw new Error("Session attention history made no progress")
      const events = appendLocalSessionAttention(meta.sessionRef, { workspaceId: row.workspaceId, sessionId: row.sessionId,
        generation: page.generation, through,
        events: page.events.filter((event) => event.sequence > after && event.sequence <= through) })
      for (const item of events) {
        if (!stopped) publish({ ...base, type: "session.attention.raised", generation: item.generation, event: item.event, ts: item.event.openedAt })
      }
      after = through
    }
    if (stopped) return
    const signature = JSON.stringify([row.title, row.attention, row.status, row.lastTurn])
    if (signatures.get(key) !== signature) {
      publish({ ...base, type: "session.status.changed", attention: row.attention, status: row.status,
        ...(row.lastTurn ? { lastTurn: row.lastTurn } : {}), ts: row.status.at })
      signatures.set(key, signature)
      while (signatures.size > 10_000) signatures.delete(signatures.keys().next().value!)
    }
  }

  async function sessionChanged(workspaceId: string, sessionId: string) {
    if (started) await started.catch(() => {})
    return enqueue(workspaceId, sessionId, async () => {
      const row = await options.source.readRow(workspaceId, sessionId)
      if (row.kind !== "row") return
      await publishRow(row.row, !initialWorkspacesKnown || pendingInitialWorkspaces.has(workspaceId))
    })
  }

  async function seedWorkspace(workspaceId: string) {
    try {
      await options.source.prepareWorkspace(workspaceId)
      const rows = await options.source.listRows(workspaceId)
      const replayed = !initialWorkspacesKnown || pendingInitialWorkspaces.has(workspaceId)
      await Promise.all(rows.map((row) => enqueue(workspaceId, row.sessionId,
        () => publishRow(row, replayed))))
      pendingInitialWorkspaces.delete(workspaceId)
    } catch (error) {
      options.onError?.(error, workspaceId)
      if (!options.onError) console.error("Local session attention snapshot failed", { workspaceId, error })
      retry(`workspace:${workspaceId}`, () => seedWorkspace(workspaceId))
      throw error
    }
  }

  async function seedAll() {
    let ids: string[]
    try { ids = await options.workspaceIds() } catch (error) {
      console.error("Local session attention workspace discovery failed", { error })
      retry("inventory", seedAll)
      throw error
    }
    if (!initialWorkspacesKnown) {
      for (const workspaceId of ids) pendingInitialWorkspaces.add(workspaceId)
      initialWorkspacesKnown = true
    }
    const results = await Promise.allSettled(ids.map(seedWorkspace))
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, "Local session attention snapshot is incomplete")
  }

  return {
    start() {
      started ??= seedAll()
      return started
    },
    sessionChanged,
    workspaceChanged: seedWorkspace,
    stop() {
      stopped = true
      for (const timer of retries.values()) clearTimeout(timer)
      retries.clear()
    },
  }
}

function validateHistoryPage(page: SessionAttentionPage, after: number) {
  if (!Number.isSafeInteger(page.through) || page.through < after || page.generation > page.through
    || page.next !== undefined && (!Number.isSafeInteger(page.next) || page.next <= after || page.next >= page.through
      || page.next !== page.events[page.events.length - 1]?.sequence)) throw new Error("Invalid canonical session attention page boundary")
  let previous = Math.max(after, page.generation)
  for (const event of page.events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= previous || event.sequence > page.through) {
      throw new Error("Invalid canonical session attention event order")
    }
    previous = event.sequence
  }
}
