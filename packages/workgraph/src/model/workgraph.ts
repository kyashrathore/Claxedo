import { Database } from "bun:sqlite"
import { GraphEngine } from "../orchestrator/graph/graph"
import type { ConnectorInterface, NormalizedIssue } from "../orchestrator/events/connector"
import type { WorkItem, WorkEdge, WorkEvent, WorkEventType, WorkGraphState, ScratchpadEntry, ScratchpadPriority } from "./types"
import {
  initDb,
  insertEvent,
  getEvents as dbGetEvents,
  getMaxSeq,
  insertItem,
  updateItem as dbUpdateItem,
  deleteItem as dbDeleteItem,
  getItem as dbGetItem,
  getAllItems,
  insertEdge,
  deleteEdge,
  getAllEdges,
  insertScratchpad as dbInsertScratchpad,
  updateScratchpad as dbUpdateScratchpad,
  getScratchpadsByItem,
  getScratchpadsNeedingReview,
  getAllScratchpads,
  getScratchpad as dbGetScratchpad,
} from "./db"
import { replayEvents } from "./reducer"

const STATUS_TO_GRAPH: Record<WorkItem["status"], "pending" | "active" | "completed"> = {
  open: "pending",
  in_progress: "active",
  done: "completed",
}

export class WorkGraph {
  private db: Database
  private graph: GraphEngine
  private seq: number

  constructor(dbPath?: string) {
    this.db = initDb(dbPath)
    const items = getAllItems(this.db)
    const edges = getAllEdges(this.db)
    this.seq = getMaxSeq(this.db)

    this.graph = new GraphEngine(
      items.map((it) => ({
        id: it.id,
        status: STATUS_TO_GRAPH[it.status],
      })),
      edges.map((e) => ({
        source_id: e.source,
        target_id: e.target,
        type: "hard" as const,
      })),
    )
  }

  create(input: {
    title: string
    description?: string
    status?: WorkItem["status"]
    labels?: string[]
    context?: string
    provider?: string
    providerMeta?: Record<string, any>
    providerUrl?: string
  }): WorkItem {
    const now = new Date().toISOString()
    const item: WorkItem = {
      id: crypto.randomUUID(),
      title: input.title,
      description: input.description ?? "",
      status: input.status ?? "open",
      labels: input.labels ?? [],
      context: input.context,
      provider: input.provider,
      providerMeta: input.providerMeta,
      providerUrl: input.providerUrl,
      createdAt: now,
      updatedAt: now,
    }

    insertItem(this.db, item)
    this.graph.addNode({ id: item.id, status: STATUS_TO_GRAPH[item.status] })
    this.emit("item_created", item, "system")

    return item
  }

  update(id: string, changes: Partial<Omit<WorkItem, "id" | "createdAt">>): WorkItem {
    const existing = dbGetItem(this.db, id)
    if (!existing) throw new Error(`WorkItem '${id}' not found`)

    const updatedChanges = { ...changes, updatedAt: new Date().toISOString() }
    dbUpdateItem(this.db, id, updatedChanges)

    if (changes.status) {
      this.graph.updateNodeStatus(id, STATUS_TO_GRAPH[changes.status])
    }

    this.emit("item_updated", { id, changes: updatedChanges }, "system")
    return { ...existing, ...updatedChanges }
  }

  remove(id: string): void {
    const existing = dbGetItem(this.db, id)
    if (!existing) throw new Error(`WorkItem '${id}' not found`)

    dbDeleteItem(this.db, id)
    this.graph.removeNode(id)
    this.emit("item_removed", { id }, "system")
  }

  get(id: string): WorkItem | undefined {
    return dbGetItem(this.db, id)
  }

  getAll(): WorkItem[] {
    return getAllItems(this.db)
  }

  addDep(blocking: string, blocked: string): void {
    if (!dbGetItem(this.db, blocking)) throw new Error(`WorkItem '${blocking}' not found`)
    if (!dbGetItem(this.db, blocked)) throw new Error(`WorkItem '${blocked}' not found`)

    this.graph.addEdge({ source_id: blocking, target_id: blocked, type: "hard" })

    if (this.graph.hasCycles()) {
      this.graph.removeEdge(blocking, blocked)
      throw new Error(`Adding dependency ${blocking} → ${blocked} would create a cycle`)
    }

    insertEdge(this.db, blocking, blocked)
    this.emit("edge_added", { source: blocking, target: blocked }, "system")
  }

  removeDep(blocking: string, blocked: string): void {
    deleteEdge(this.db, blocking, blocked)
    this.graph.removeEdge(blocking, blocked)
    this.emit("edge_removed", { source: blocking, target: blocked }, "system")
  }

  getUnblocked(): WorkItem[] {
    const items = getAllItems(this.db)
    return items.filter(
      (it) => it.status === "open" && this.graph.isReady(it.id),
    )
  }

  getBlockedBy(id: string): WorkItem[] {
    const incoming = this.graph.getIncomingEdges(id)
    const ids = incoming.map((e) => e.source_id)
    return ids
      .map((sid) => dbGetItem(this.db, sid))
      .filter((it): it is WorkItem => it !== undefined)
  }

  getBlocking(id: string): WorkItem[] {
    const outgoing = this.graph.getOutgoingEdges(id)
    const ids = outgoing.map((e) => e.target_id)
    return ids
      .map((tid) => dbGetItem(this.db, tid))
      .filter((it): it is WorkItem => it !== undefined)
  }

  isBlocked(id: string): boolean {
    const item = dbGetItem(this.db, id)
    if (!item || item.status !== "open") return false
    return !this.graph.isReady(id)
  }

  async complete(id: string, connector?: ConnectorInterface): Promise<WorkItem> {
    const item = this.update(id, { status: "done" })
    const downstream = this.getBlocking(id)

    if (connector && downstream.length > 0) {
      const { onComplete } = await import("./hooks")
      await onComplete(item, downstream, (tid) => this.getBlockedBy(tid), connector)
    }

    return item
  }

  async hydrateSlice(
    connector: ConnectorInterface,
    params: Record<string, any>[],
  ): Promise<WorkItem[]> {
    const hydrated: WorkItem[] = []

    for (const p of params) {
      const normalized: NormalizedIssue = await connector.hydrateIssue(p)
      const statusMap: Record<NormalizedIssue["status"], WorkItem["status"]> = {
        open: "open",
        in_progress: "in_progress",
        closed: "done",
      }
      const now = new Date().toISOString()
      const item: WorkItem = {
        id: crypto.randomUUID(),
        title: normalized.title,
        description: normalized.description,
        status: statusMap[normalized.status],
        labels: [],
        provider: connector.provider,
        providerMeta: p,
        providerUrl: normalized.provider_url,
        createdAt: now,
        updatedAt: now,
      }

      insertItem(this.db, item)
      this.graph.addNode({ id: item.id, status: STATUS_TO_GRAPH[item.status] })
      this.emit("item_hydrated", item, `connector:${connector.provider}`)
      hydrated.push(item)
    }

    return hydrated
  }

  async pushStatus(id: string, connector: ConnectorInterface): Promise<void> {
    const item = dbGetItem(this.db, id)
    if (!item) throw new Error(`WorkItem '${id}' not found`)
    if (!item.providerMeta) throw new Error(`WorkItem '${id}' has no providerMeta`)

    const statusMap: Record<WorkItem["status"], string> = {
      open: "open",
      in_progress: "in_progress",
      done: "closed",
    }

    await connector.updateIssue(item.providerMeta, { status: statusMap[item.status] })
    this.emit("item_synced", { id, changes: { status: item.status } }, `connector:${connector.provider}`)
  }

  getState(): WorkGraphState {
    const items = getAllItems(this.db)
    const edges = getAllEdges(this.db)
    const scratchpads = getAllScratchpads(this.db)
    return {
      items: Object.fromEntries(items.map((it) => [it.id, it])),
      edges,
      scratchpads,
    }
  }

  replayState(): WorkGraphState {
    const events = dbGetEvents(this.db)
    return replayEvents(events)
  }

  getEvents(sinceSeq?: number): WorkEvent[] {
    return dbGetEvents(this.db, sinceSeq)
  }

  writeScratchpad(input: {
    workItemId: string
    content: string
    priority?: ScratchpadPriority
    actor?: string
  }): ScratchpadEntry {
    const existing = dbGetItem(this.db, input.workItemId)
    if (!existing) throw new Error(`WorkItem '${input.workItemId}' not found`)

    const priority = input.priority ?? "fyi"
    const entry: ScratchpadEntry = {
      id: crypto.randomUUID(),
      workItemId: input.workItemId,
      content: input.content,
      priority,
      needsReview: priority === "blocking" || priority === "scope_change",
      actor: input.actor ?? "system",
      createdAt: new Date().toISOString(),
    }

    dbInsertScratchpad(this.db, entry)
    this.emit("scratchpad_written", entry, entry.actor)
    return entry
  }

  promoteScratchpad(scratchpadId: string, opts?: {
    addDep?: boolean
    title?: string
    description?: string
  }): WorkItem {
    const entry = dbGetScratchpad(this.db, scratchpadId)
    if (!entry) throw new Error(`Scratchpad '${scratchpadId}' not found`)
    if (entry.promotedToItemId) throw new Error(`Scratchpad '${scratchpadId}' already promoted`)
    if (entry.dismissedAt) throw new Error(`Scratchpad '${scratchpadId}' already dismissed`)

    const item = this.create({
      title: opts?.title ?? entry.content,
      description: opts?.description ?? "",
    })

    dbUpdateScratchpad(this.db, scratchpadId, { promotedToItemId: item.id })

    if (opts?.addDep) {
      try {
        this.addDep(item.id, entry.workItemId)
      } catch (_) {
        // dependency may cause cycle or item may be done, skip silently
      }
    }

    this.emit("scratchpad_promoted", { scratchpadId, promotedToItemId: item.id }, entry.actor)
    return item
  }

  dismissScratchpad(scratchpadId: string): void {
    const entry = dbGetScratchpad(this.db, scratchpadId)
    if (!entry) throw new Error(`Scratchpad '${scratchpadId}' not found`)
    if (entry.promotedToItemId) throw new Error(`Scratchpad '${scratchpadId}' already promoted`)
    if (entry.dismissedAt) throw new Error(`Scratchpad '${scratchpadId}' already dismissed`)

    const now = new Date().toISOString()
    dbUpdateScratchpad(this.db, scratchpadId, { dismissedAt: now })
    this.emit("scratchpad_dismissed", { scratchpadId, dismissedAt: now }, "system")
  }

  getScratchpads(workItemId?: string): ScratchpadEntry[] {
    if (workItemId) {
      return getScratchpadsByItem(this.db, workItemId)
    }
    return getAllScratchpads(this.db)
  }

  getPendingReview(): ScratchpadEntry[] {
    return getScratchpadsNeedingReview(this.db)
  }

  close(): void {
    this.db.close()
  }

  private emit(type: WorkEventType, payload: any, actor: string): void {
    this.seq++
    const event: WorkEvent = {
      id: crypto.randomUUID(),
      seq: this.seq,
      type,
      payload: JSON.stringify(payload),
      actor,
      createdAt: new Date().toISOString(),
    }
    insertEvent(this.db, event)
  }
}
