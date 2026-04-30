import { GraphEngine } from "../orchestrator/graph/graph"
import type { ConnectorInterface, NormalizedIssue } from "../orchestrator/events/connector"
import type { WorkItem, WorkEdge, WorkEvent, WorkEventType, WorkGraphState, ScratchpadEntry, ScratchpadPriority, WorkNodeType } from "./types"
import type { WorkGraphRepo } from "./repo"
import { openSqlite } from "./db"
import { replayEvents } from "./reducer"
import { inferRepo } from "../repo"

const STATUS_TO_GRAPH: Record<WorkItem["status"], "pending" | "active" | "completed"> = {
  open: "pending",
  in_progress: "active",
  done: "completed",
}

export class WorkGraph {
  private repo: WorkGraphRepo
  private graph: GraphEngine
  private seq: number

  constructor(repo?: WorkGraphRepo | string) {
    this.repo = typeof repo === "string" || repo === undefined ? openSqlite(repo) : repo
    const items = this.repo.getAllItems().filter((item) => !item.deletedAt && this.exec(item))
    const ids = new Set(items.map((item) => item.id))
    const edges = this.repo.getAllEdges().filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    this.seq = this.repo.getMaxSeq()

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
    for (const item of this.repo.getAllItems()) {
      if (item.nodeType !== "mission" || item.deletedAt || item.archivedAt) continue
      this.ensureSynthesis(item.id)
    }
    this.syncMissions()
  }

  create(input: {
    sourceId?: string
    parentId?: string | null
    repoRef?: string | null
    repoLabel?: string | null
    title: string
    description?: string
    nodeType?: WorkNodeType
    status?: WorkItem["status"]
    labels?: string[]
    context?: string
    provider?: string
    providerMeta?: Record<string, unknown>
    providerUrl?: string
  }): WorkItem {
    const now = new Date().toISOString()
    const parent = input.parentId ? this.repo.getItem(input.parentId) : null
    if (input.parentId && !parent) {
      throw new Error(`WorkItem '${input.parentId}' not found`)
    }
    const repoRef = input.repoRef ?? parent?.repoRef ?? null
    const repoLabel = input.repoLabel ?? parent?.repoLabel ?? null
    if (parent?.repoRef && repoRef !== parent.repoRef) {
      throw new Error("Parent and child items must stay in the same repo")
    }
    const item: WorkItem = {
      id: crypto.randomUUID(),
      sourceId: input.sourceId,
      parentId: input.parentId ?? null,
      repoRef,
      repoLabel,
      title: input.title,
      description: input.description ?? "",
      nodeType: input.nodeType ?? "task",
      status: input.status ?? "open",
      labels: input.labels ?? [],
      context: input.context,
      provider: input.provider,
      providerMeta: input.providerMeta,
      providerUrl: input.providerUrl,
      createdAt: now,
      updatedAt: now,
    }

    this.repo.insertItem(item)
    if (this.exec(item)) {
      this.graph.addNode({ id: item.id, status: STATUS_TO_GRAPH[item.status] })
    }
    this.emit("item_created", item, "system")
    if (item.nodeType === "mission") {
      this.ensureSynthesis(item.id)
    } else {
      this.syncMissions()
    }

    return item
  }

  update(id: string, changes: Partial<Omit<WorkItem, "id" | "createdAt">>): WorkItem {
    const existing = this.repo.getItem(id)
    if (!existing) throw new Error(`WorkItem '${id}' not found`)

    const parentId = changes.parentId !== undefined ? changes.parentId : existing.parentId ?? null
    const parent = parentId ? this.repo.getItem(parentId) : null
    if (parentId && !parent) throw new Error(`WorkItem '${parentId}' not found`)
    const next = {
      ...existing,
      ...changes,
      parentId,
      repoRef: changes.repoRef !== undefined ? changes.repoRef : existing.repoRef ?? parent?.repoRef ?? null,
      repoLabel: changes.repoLabel !== undefined ? changes.repoLabel : existing.repoLabel ?? parent?.repoLabel ?? null,
      updatedAt: new Date().toISOString(),
    }
    if (parent?.repoRef && next.repoRef !== parent.repoRef) {
      throw new Error("Parent and child items must stay in the same repo")
    }
    const updatedChanges = {
      ...changes,
      parentId: next.parentId,
      repoRef: next.repoRef,
      repoLabel: next.repoLabel,
    }
    this.repo.updateItem(id, updatedChanges)

    if (this.exec(existing) && !this.exec(next)) {
      this.graph.removeNode(id)
    } else if (!this.exec(existing) && this.exec(next) && !next.deletedAt) {
      this.graph.addNode({ id, status: STATUS_TO_GRAPH[next.status] })
    } else if (this.exec(next) && changes.status && !existing.deletedAt && !changes.deletedAt) {
      this.graph.updateNodeStatus(id, STATUS_TO_GRAPH[changes.status])
    }

    this.emit("item_updated", { id, changes: updatedChanges }, "system")
    this.syncMissions()
    return next
  }

  remove(id: string): void {
    const existing = this.repo.getItem(id)
    if (!existing) throw new Error(`WorkItem '${id}' not found`)
    if (existing.deletedAt) return

    const edges = [
      ...this.graph.getIncomingEdges(id).map((edge) => ({ source: edge.source_id, target: edge.target_id })),
      ...this.graph.getOutgoingEdges(id).map((edge) => ({ source: edge.source_id, target: edge.target_id })),
    ]
    this.repo.deleteItem(id)
    edges.forEach((edge) => this.graph.removeEdge(edge.source, edge.target))
    this.graph.removeNode(id)
    edges.forEach((edge) => this.emit("edge_removed", edge, "system"))
    this.update(id, {
      deletedAt: new Date().toISOString(),
      deletedReason: existing.deletedReason,
    })
  }

  archive(id: string, reason?: string): WorkItem {
    const item = this.repo.getItem(id)
    if (!item) throw new Error(`WorkItem '${id}' not found`)
    if (item.deletedAt) throw new Error(`WorkItem '${id}' is deleted`)
    if (item.archivedAt) return item
    return this.update(id, {
      archivedAt: new Date().toISOString(),
      archivedReason: reason,
    })
  }

  get(id: string): WorkItem | undefined {
    return this.repo.getItem(id)
  }

  getAll(): WorkItem[] {
    return this.repo.getAllItems()
  }

  getBySource(sourceId: string): WorkItem[] {
    return this.getBySlice(sourceId)
  }

  removeBySource(sourceId: string): void {
    this.removeBySlice(sourceId)
  }

  getBySlice(sliceId: string): WorkItem[] {
    const ids = new Set(this.repo.getSliceItems(sliceId))
    return this.repo.getAllItems().filter((item) => ids.has(item.id))
  }

  getSlices(id: string): string[] {
    return this.repo.getItemSlices(id)
  }

  linkSlice(id: string, sliceId: string): void {
    if (!this.repo.getItem(id)) throw new Error(`WorkItem '${id}' not found`)
    this.repo.linkItemSlice(id, sliceId)
  }

  removeBySlice(sliceId: string): void {
    this.getBySlice(sliceId).forEach((item) => this.remove(item.id))
  }

  addDep(blocking: string, blocked: string): void {
    const source = this.repo.getItem(blocking)
    const target = this.repo.getItem(blocked)
    if (!source) throw new Error(`WorkItem '${blocking}' not found`)
    if (!target) throw new Error(`WorkItem '${blocked}' not found`)
    if (!this.exec(source) || !this.exec(target)) throw new Error("Mission items cannot participate in execution dependencies")
    if (source.repoRef || target.repoRef) {
      if (!source.repoRef || !target.repoRef || source.repoRef !== target.repoRef) {
        throw new Error("Dependencies must stay within one repo")
      }
    }

    this.graph.addEdge({ source_id: blocking, target_id: blocked, type: "hard" })

    if (this.graph.hasCycles()) {
      this.graph.removeEdge(blocking, blocked)
      throw new Error(`Adding dependency ${blocking} → ${blocked} would create a cycle`)
    }

    this.repo.insertEdge(blocking, blocked)
    this.emit("edge_added", { source: blocking, target: blocked }, "system")
  }

  removeDep(blocking: string, blocked: string): void {
    this.repo.deleteEdge(blocking, blocked)
    this.graph.removeEdge(blocking, blocked)
    this.emit("edge_removed", { source: blocking, target: blocked }, "system")
  }

  getUnblocked(): WorkItem[] {
    const items = this.repo.getAllItems()
    return items.filter(
      (it) => this.active(it) && this.exec(it) && it.status === "open" && this.graph.isReady(it.id),
    )
  }

  getBlockedBy(id: string): WorkItem[] {
    const incoming = this.graph.getIncomingEdges(id)
    const ids = incoming.map((e) => e.source_id)
    return ids
      .map((sid) => this.repo.getItem(sid))
      .filter((it): it is WorkItem => it !== undefined)
  }

  getBlocking(id: string): WorkItem[] {
    const outgoing = this.graph.getOutgoingEdges(id)
    const ids = outgoing.map((e) => e.target_id)
    return ids
      .map((tid) => this.repo.getItem(tid))
      .filter((it): it is WorkItem => it !== undefined)
  }

  isBlocked(id: string): boolean {
    const item = this.repo.getItem(id)
    if (!item || !this.active(item) || !this.exec(item) || item.status !== "open") return false
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
    params: Record<string, unknown>[],
  ): Promise<WorkItem[]> {
    return this.importSlice(connector, params)
  }

  async importSlice(
    connector: ConnectorInterface,
    params: Record<string, unknown>[],
    opts?: {
      sourceId?: string
      parentId?: string | null
      repoRef?: string | null
      repoLabel?: string | null
    },
  ): Promise<WorkItem[]> {
    const issues = await Promise.all(params.map((input) => connector.hydrateIssue(input)))
    const statusMap: Record<NormalizedIssue["status"], WorkItem["status"]> = {
      open: "open",
      in_progress: "in_progress",
      closed: "done",
    }
    const refs = new Map<string, WorkItem>()
    const rows = issues.map((issue, idx) => {
      const input = params[idx] ?? {}
      const repo = opts?.repoRef
        ? { repoRef: opts.repoRef, repoLabel: opts.repoLabel ?? null }
        : inferRepo(connector.provider, input, issue.provider_url)
      const repoRef = !repo ? null : "repo_ref" in repo ? repo.repo_ref : repo.repoRef
      const repoLabel = !repo ? null : "repo_label" in repo ? repo.repo_label : repo.repoLabel
      const item = this.create({
        sourceId: opts?.sourceId ?? text(input.source_id),
        parentId: opts?.parentId ?? null,
        repoRef: repoRef ?? null,
        repoLabel: repoLabel ?? null,
        title: issue.title,
        description: issue.description,
        nodeType: issue.aggregate_only ? "mission" : "task",
        status: statusMap[issue.status],
        labels: issue.aggregate_only ? ["mission", connector.provider] : [connector.provider],
        provider: connector.provider,
        providerMeta: input,
        providerUrl: issue.provider_url,
      })
      const key = issue.external_key ?? `${connector.provider}:${issue.id}`
      refs.set(key, item)
      this.emit("item_hydrated", item, `connector:${connector.provider}`)
      return { issue, item }
    })

    for (const row of rows) {
      const key = row.issue.parent_external_key
        ?? rows.find((item) => (item.issue.child_external_keys ?? []).includes(row.issue.external_key ?? `${connector.provider}:${row.issue.id}`))?.issue.external_key
      if (!key) continue
      const parent = refs.get(key)
      if (!parent) continue
      this.update(row.item.id, { parentId: parent.id })
    }

    const missions = rows
      .map((row) => row.item)
      .filter((item) => item.nodeType === "mission")
      .map((item) => item.id)
    for (const id of missions) {
      this.ensureSynthesis(id)
    }

    this.syncMissions()
    return rows
      .map((row) => this.get(row.item.id))
      .filter((item): item is WorkItem => !!item)
  }

  getChildren(id: string): WorkItem[] {
    return this.repo.getAllItems().filter((item) => item.parentId === id && !item.deletedAt)
  }

  getDescendants(id: string): WorkItem[] {
    const out: WorkItem[] = []
    const seen = new Set<string>()
    const walk = (parentId: string) => {
      for (const item of this.getChildren(parentId)) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        out.push(item)
        walk(item.id)
      }
    }
    walk(id)
    return out
  }

  ensureSynthesis(id: string): WorkItem | undefined {
    const item = this.repo.getItem(id)
    if (!item || item.nodeType !== "mission" || item.deletedAt) return
    const kids = this.getChildren(id)
    const found = kids.find((child) => child.nodeType === "synthesis" && !child.deletedAt)
    const synth = found ?? this.create({
      sourceId: item.sourceId,
      parentId: item.id,
      repoRef: item.repoRef ?? null,
      repoLabel: item.repoLabel ?? null,
      title: `Synthesize ${item.title}`,
      description: `Consolidate the outputs from the child work under "${item.title}" into one final markdown report.`,
      nodeType: "synthesis",
      labels: ["synthesis"],
      context: item.context ? `${item.context} mission:${item.id}` : `mission:${item.id}`,
    })
    const want = new Set(
      this.getDescendants(item.id)
        .filter((child) => child.id !== synth.id && this.exec(child) && !child.archivedAt && !child.deletedAt)
        .map((child) => child.id),
    )
    const have = new Set(this.getBlockedBy(synth.id).map((child) => child.id))
    for (const child of have) {
      if (want.has(child)) continue
      this.removeDep(child, synth.id)
    }
    for (const child of want) {
      if (have.has(child)) continue
      this.addDep(child, synth.id)
    }
    this.syncMissions()
    return synth
  }

  async pushStatus(id: string, connector: ConnectorInterface): Promise<void> {
    const item = this.repo.getItem(id)
    if (!item) throw new Error(`WorkItem '${id}' not found`)
    if (!item.providerMeta) throw new Error(`WorkItem '${id}' has no providerMeta`)
    const binding = this.binding(item, connector.provider)
    if (!binding) throw new Error(`WorkItem '${id}' has no providerMeta`)

    const all = this.repo.getAllItems().filter((node) => this.binding(node, connector.provider)?.key === binding.key)
    const active = all.filter((node) => !node.archivedAt && !node.deletedAt)
    const started = all.some((node) => node.status !== "open")
    const left = active.filter((node) => node.status !== "done")
    const running = left.some((node) => node.status === "in_progress")
    const ready = left.filter((node) => node.status === "open" && !this.isBlocked(node.id))
    const done = active.length > 0 && active.every((node) => node.status === "done")
    const blocked = started && !running && left.length > 0 && ready.length === 0
    const sync = this.repo.getSyncProjection(binding.key)

    if (done) {
      if (sync?.lastStatus !== "closed") {
        await connector.updateIssue(binding.meta, { status: "closed" })
      }
      this.repo.upsertSyncProjection({
        bindingKey: binding.key,
        provider: connector.provider,
        providerMeta: binding.meta,
        lastStatus: "closed",
        blockedHash: sync?.blockedHash,
        archiveHash: sync?.archiveHash,
      })
      this.emit("item_synced", { id, changes: { status: "done" } }, `connector:${connector.provider}`)
      return
    }

    if (running) {
      if (sync?.lastStatus !== "in_progress") {
        await connector.updateIssue(binding.meta, { status: "in_progress" })
      }
      this.repo.upsertSyncProjection({
        bindingKey: binding.key,
        provider: connector.provider,
        providerMeta: binding.meta,
        lastStatus: "in_progress",
        blockedHash: sync?.blockedHash,
        archiveHash: sync?.archiveHash,
      })
      this.emit("item_synced", { id, changes: { status: "in_progress" } }, `connector:${connector.provider}`)
      return
    }

    if (active.length === 0) {
      if (!started) return
      const hash = "archive:local-work-archived"
      if (sync?.archiveHash !== hash) {
        await connector.addComment(binding.meta, "Local WorkGraph work was archived or deleted before completion.")
      }
      this.repo.upsertSyncProjection({
        bindingKey: binding.key,
        provider: connector.provider,
        providerMeta: binding.meta,
        lastStatus: sync?.lastStatus,
        blockedHash: sync?.blockedHash,
        archiveHash: hash,
      })
      return
    }

    if (!blocked) return
    const hash = "blocked:no-ready-work"
    if (sync?.blockedHash !== hash) {
      await connector.addComment(binding.meta, "Local WorkGraph work is blocked with no ready tasks remaining.")
    }
    this.repo.upsertSyncProjection({
      bindingKey: binding.key,
      provider: connector.provider,
      providerMeta: binding.meta,
      lastStatus: sync?.lastStatus,
      blockedHash: hash,
      archiveHash: sync?.archiveHash,
    })
  }

  getState(): WorkGraphState {
    const items = this.repo.getAllItems()
    const edges = this.repo.getAllEdges()
    const scratchpads = this.repo.getAllScratchpads()
    return {
      items: Object.fromEntries(items.map((it) => [it.id, it])),
      edges,
      scratchpads,
    }
  }

  replayState(): WorkGraphState {
    const events = this.repo.getEvents()
    return replayEvents(events)
  }

  getEvents(sinceSeq?: number): WorkEvent[] {
    return this.repo.getEvents(sinceSeq)
  }

  writeScratchpad(input: {
    workItemId: string
    content: string
    priority?: ScratchpadPriority
    actor?: string
  }): ScratchpadEntry {
    const existing = this.repo.getItem(input.workItemId)
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

    this.repo.insertScratchpad(entry)
    this.emit("scratchpad_written", entry, entry.actor)
    return entry
  }

  promoteScratchpad(scratchpadId: string, opts?: {
    addDep?: boolean
    title?: string
    description?: string
  }): WorkItem {
    const entry = this.repo.getScratchpad(scratchpadId)
    if (!entry) throw new Error(`Scratchpad '${scratchpadId}' not found`)
    if (entry.promotedToItemId) throw new Error(`Scratchpad '${scratchpadId}' already promoted`)
    if (entry.dismissedAt) throw new Error(`Scratchpad '${scratchpadId}' already dismissed`)

    const item = this.create({
      title: opts?.title ?? entry.content,
      description: opts?.description ?? "",
    })

    this.repo.updateScratchpad(scratchpadId, { promotedToItemId: item.id })

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
    const entry = this.repo.getScratchpad(scratchpadId)
    if (!entry) throw new Error(`Scratchpad '${scratchpadId}' not found`)
    if (entry.promotedToItemId) throw new Error(`Scratchpad '${scratchpadId}' already promoted`)
    if (entry.dismissedAt) throw new Error(`Scratchpad '${scratchpadId}' already dismissed`)

    const now = new Date().toISOString()
    this.repo.updateScratchpad(scratchpadId, { dismissedAt: now })
    this.emit("scratchpad_dismissed", { scratchpadId, dismissedAt: now }, "system")
  }

  getScratchpads(workItemId?: string): ScratchpadEntry[] {
    if (workItemId) {
      return this.repo.getScratchpadsByItem(workItemId)
    }
    return this.repo.getAllScratchpads()
  }

  getPendingReview(): ScratchpadEntry[] {
    return this.repo.getScratchpadsNeedingReview()
  }

  close(): void {
    this.repo.close()
  }

  private active(item: WorkItem) {
    return !item.archivedAt && !item.deletedAt
  }

  private exec(item: WorkItem) {
    return item.nodeType !== "mission"
  }

  private syncMissions() {
    const items = this.repo.getAllItems().filter((item) => !item.deletedAt)
    const kids = new Map<string, WorkItem[]>()
    for (const item of items) {
      if (!item.parentId) continue
      const list = kids.get(item.parentId) ?? []
      list.push(item)
      kids.set(item.parentId, list)
    }

    const walk = (item: WorkItem): WorkItem["status"] => {
      const direct = (kids.get(item.id) ?? []).filter((child) => !child.archivedAt && !child.deletedAt)
      for (const child of direct) {
        if (child.nodeType === "mission") walk(child)
      }
      const exec = this.getDescendants(item.id).filter((child) => this.active(child) && this.exec(child))
      const next = exec.length > 0 && exec.every((child) => child.status === "done")
        ? "done"
        : exec.some((child) => child.status === "in_progress")
          ? "in_progress"
          : "open"
      if (item.status === next) return next
      this.repo.updateItem(item.id, { status: next })
      item.status = next
      this.emit("item_updated", { id: item.id, changes: { status: next } }, "system")
      return next
    }

    for (const item of items) {
      if (item.nodeType !== "mission" || item.archivedAt) continue
      walk(item)
    }
  }

  private binding(item: WorkItem, provider?: string) {
    if (!item.providerMeta) return null
    const name = item.provider ?? provider
    if (!name) return null
    return {
      key: `${name}:${stable(item.providerMeta)}`,
      meta: item.providerMeta,
    }
  }

  private emit(type: WorkEventType, payload: unknown, actor: string): void {
    this.seq++
    const event: WorkEvent = {
      id: crypto.randomUUID(),
      seq: this.seq,
      type,
      payload: JSON.stringify(payload),
      actor,
      createdAt: new Date().toISOString(),
    }
    this.repo.insertEvent(event)
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}
