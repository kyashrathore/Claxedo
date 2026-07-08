import { GraphEngine } from "./graph"
import type { ConnectorInterface, NormalizedIssue } from "../connectors/interface"
import type { WorkItem, WorkEdge, WorkEvent, WorkEventType, WorkGraphState, ScratchpadEntry, ScratchpadPriority, ScratchpadKind, ScratchpadSubjectType, WorkNodeType, ReviewableDecision, ReviewBatch, LoadoutSlot, LoadoutKind, LoadoutScopeType, IntakeItem, IntakeActivity, ExternalReference } from "./types"
import type { WorkGraphRepo } from "./repo"
import { openSqlite } from "./db"
import { replayEvents } from "./reducer"
import { resolveLoadout, type LoadoutSubject } from "./loadout"
import { inferRepo } from "../repo"
import { buildProvenance, type ProvenanceInput } from "./provenance"
import { defaultRules, getPolicy, routeChange } from "./policy"
import type { Intent, PolicyDecision, RouteContext, Rule } from "./policy-types"

const STATUS_TO_GRAPH: Record<WorkItem["status"], "pending" | "active" | "completed"> = {
  open: "pending",
  in_progress: "active",
  done: "completed",
}

interface MutationOptions {
  provenance?: ProvenanceInput
}

export interface ProposeContext extends RouteContext {
  actor?: ProvenanceInput["actor"]
  policyName?: string
  rules?: readonly Rule[]
}

export type ProposeResult =
  | {
    outcome: "applied"
    firedRuleId: string
    item?: WorkItem
  }
  | {
    outcome: "decision"
    firedRuleId: string
    decision: ReviewableDecision
  }

export type ReviewAnswer =
  | { decisionId: string; action: "accept"; payload?: Record<string, unknown>; freeTextAnswer?: string }
  | { decisionId: string; action: "reject" }
  | { decisionId: string; action: "edit"; payload: Record<string, unknown>; freeTextAnswer?: string }

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

  propose(intent: Intent, ctx: ProposeContext = {}): ProposeResult {
    const actor = ctx.actor ?? "captain"
    try {
      const routed = routeChange(intent, this.resolvePolicyRules(ctx), ctx)
      this.emit("captain_proposed", {
        intent,
        outcome: routed.outcome,
        firedRuleId: routed.firedRuleId,
      }, actor)

      if (routed.outcome === "apply") {
        return {
          outcome: "applied",
          firedRuleId: routed.firedRuleId,
          item: this.applyIntent(routed.intent, routed.firedRuleId, actor),
        }
      }

      return {
        outcome: "decision",
        firedRuleId: routed.firedRuleId,
        decision: this.createDecision(routed.decision, actor),
      }
    } catch (error) {
      this.emit("captain_failed", {
        intent,
        error: error instanceof Error ? error.message : String(error),
      }, actor)
      throw error
    }
  }

  // note: orchestrator-bridge calls this directly; Captain calls it only via propose().
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
    provenance?: ProvenanceInput
  }): WorkItem {
    const now = new Date().toISOString()
    const provenance = buildProvenance(input.provenance, { actor: "system", at: now })
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
    this.emit("item_created", { item, provenance }, provenance.actor)
    if (item.nodeType === "mission") {
      this.ensureSynthesis(item.id)
    } else {
      this.syncMissions()
    }

    return item
  }

  // note: orchestrator-bridge calls this directly; Captain calls it only via propose().
  update(id: string, changes: Partial<Omit<WorkItem, "id" | "createdAt">>, opts?: MutationOptions): WorkItem {
    const existing = this.repo.getItem(id)
    if (!existing) throw new Error(`WorkItem '${id}' not found`)
    const provenance = buildProvenance(opts?.provenance, { actor: "system" })

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

    this.emit("item_updated", { id, changes: updatedChanges, provenance }, provenance.actor)
    this.syncMissions()
    return next
  }

  // note: orchestrator-bridge calls this directly; Captain calls it only via propose().
  remove(id: string, opts?: MutationOptions): void {
    const existing = this.repo.getItem(id)
    if (!existing) throw new Error(`WorkItem '${id}' not found`)
    if (existing.deletedAt) return
    const provenance = buildProvenance(opts?.provenance, { actor: "system" })

    const edges = [
      ...this.graph.getIncomingEdges(id).map((edge) => ({ source: edge.source_id, target: edge.target_id })),
      ...this.graph.getOutgoingEdges(id).map((edge) => ({ source: edge.source_id, target: edge.target_id })),
    ]
    this.repo.deleteItem(id)
    edges.forEach((edge) => this.graph.removeEdge(edge.source, edge.target))
    this.graph.removeNode(id)
    edges.forEach((edge) => this.emit("edge_removed", { edge, provenance }, provenance.actor))
    this.update(id, {
      deletedAt: new Date().toISOString(),
      deletedReason: existing.deletedReason,
    }, { provenance })
  }

  // note: orchestrator-bridge calls this directly; Captain calls it only via propose().
  archive(id: string, reason?: string, opts?: MutationOptions): WorkItem {
    const item = this.repo.getItem(id)
    if (!item) throw new Error(`WorkItem '${id}' not found`)
    if (item.deletedAt) throw new Error(`WorkItem '${id}' is deleted`)
    if (item.archivedAt) return item
    return this.update(id, {
      archivedAt: new Date().toISOString(),
      archivedReason: reason,
    }, opts)
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

  removeBySource(sourceId: string, opts?: { preserveHumanEdited?: boolean }): void {
    this.removeBySlice(sourceId, opts)
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

  removeBySlice(sliceId: string, opts?: { preserveHumanEdited?: boolean }): void {
    this.getBySlice(sliceId)
      .filter((item) => !opts?.preserveHumanEdited || !this.hasHumanProvenance(item.id))
      .forEach((item) => this.remove(item.id))
  }

  // note: orchestrator-bridge calls this directly; Captain calls it only via propose().
  addDep(blocking: string, blocked: string, opts?: MutationOptions): void {
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
    const provenance = buildProvenance(opts?.provenance, { actor: "system" })
    this.emit("edge_added", { edge: { source: blocking, target: blocked }, provenance }, provenance.actor)
  }

  // note: orchestrator-bridge calls this directly; Captain calls it only via propose().
  removeDep(blocking: string, blocked: string, opts?: MutationOptions): void {
    this.repo.deleteEdge(blocking, blocked)
    this.graph.removeEdge(blocking, blocked)
    const provenance = buildProvenance(opts?.provenance, { actor: "system" })
    this.emit("edge_removed", { edge: { source: blocking, target: blocked }, provenance }, provenance.actor)
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

  async complete(id: string, _connector?: ConnectorInterface): Promise<WorkItem> {
    // Flat model (plan 2026-07-06-004): completing an item no longer pushes
    // downstream "unblocked" notifications to the provider — between-card
    // ordering is a human decision, surfaced by ready/blocked queries.
    return this.update(id, { status: "done" })
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
      this.emit("item_hydrated", { item, provenance: buildProvenance() }, `connector:${connector.provider}`)
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
      this.emit("item_synced", { id, changes: { status: "done" }, provenance: buildProvenance() }, `connector:${connector.provider}`)
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
      this.emit("item_synced", { id, changes: { status: "in_progress" }, provenance: buildProvenance() }, `connector:${connector.provider}`)
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
    const intakeItems = this.repo.listIntakeItems()
    return {
      items: Object.fromEntries(items.map((it) => [it.id, it])),
      edges,
      scratchpads,
      intakeItems: Object.fromEntries(intakeItems.map((item) => [item.id, item])),
      intakeActivities: intakeItems.flatMap((item) => this.repo.listIntakeActivities(item.id)),
      externalReferences: Object.fromEntries(intakeItems
        .flatMap((item) => this.repo.listExternalReferences(item.id))
        .map((item) => [item.id, item])),
      decisions: Object.fromEntries(this.repo.listReviewableDecisions().map((item) => [item.id, item])),
      batches: Object.fromEntries(this.repo.listReviewBatches().map((item) => [item.id, item])),
      loadoutSlots: Object.fromEntries(this.repo.listLoadoutSlots().map((item) => [item.id, item])),
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
    workItemId?: string
    subjectType?: ScratchpadSubjectType
    subjectId?: string
    agentRunId?: string
    kind?: ScratchpadKind
    content: string
    priority?: ScratchpadPriority
    actor?: string
  }): ScratchpadEntry {
    const subjectId = input.subjectId ?? input.workItemId
    if (!subjectId) throw new Error("Scratchpad subject_id is required")
    const subjectType = input.subjectType ?? (this.repo.getIntakeItem(subjectId) ? "intake_item" : "run_node")
    const existing = subjectType === "intake_item" ? this.repo.getIntakeItem(subjectId) : this.repo.getItem(subjectId)
    if (!existing) throw new Error(`${subjectType === "intake_item" ? "IntakeItem" : "WorkItem"} '${subjectId}' not found`)
    if (input.agentRunId && this.repo.getLatestScratchpadByRun(input.agentRunId)) {
      throw new Error(`Scratchpad for agent run '${input.agentRunId}' already exists`)
    }

    const priority = input.priority ?? "fyi"
    const entry: ScratchpadEntry = {
      id: crypto.randomUUID(),
      subjectType,
      subjectId,
      workItemId: subjectId,
      agentRunId: input.agentRunId,
      kind: input.kind ?? "executor",
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

  getLatestScratchpadByRun(agentRunId: string): ScratchpadEntry | undefined {
    return this.repo.getLatestScratchpadByRun(agentRunId)
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

  getScratchpadsBySubject(subjectType: ScratchpadSubjectType, subjectId: string): ScratchpadEntry[] {
    return this.repo.getScratchpadsBySubject(subjectType, subjectId)
  }

  getPendingReview(): ScratchpadEntry[] {
    return this.repo.getScratchpadsNeedingReview()
  }

  captureIntakeItem(input: {
    kind?: IntakeItem["kind"]
    title?: string | null
    bodyMd: string
    repoRef?: string | null
    triageModeOverride?: string | null
  }): IntakeItem {
    const now = new Date().toISOString()
    const item: IntakeItem = {
      id: crypto.randomUUID(),
      kind: input.kind ?? "manual",
      title: input.title ?? null,
      bodyMd: input.bodyMd,
      status: "captured",
      repoRef: input.repoRef ?? null,
      triageModeOverride: input.triageModeOverride ?? null,
      linkedSessionId: null,
      createdAt: now,
      updatedAt: now,
      lastTriagedAt: null,
    }
    this.repo.insertIntakeItem(item)
    this.emit("intake_item_created", item, "human")
    this.appendIntakeActivity(item.id, {
      kind: "capture",
      actor: "human",
      payload: { bodyMd: item.bodyMd, title: item.title, repoRef: item.repoRef },
    })
    return item
  }

  getIntakeItem(id: string): IntakeItem | undefined {
    return this.repo.getIntakeItem(id)
  }

  updateIntakeItem(id: string, changes: Partial<Omit<IntakeItem, "id" | "createdAt">>): IntakeItem {
    const existing = this.repo.getIntakeItem(id)
    if (!existing) throw new Error(`IntakeItem '${id}' not found`)
    this.repo.updateIntakeItem(id, changes)
    const updated = this.repo.getIntakeItem(id)!
    this.emit("intake_item_updated", { id, changes }, "system")
    return updated
  }

  archiveIntakeItem(id: string): IntakeItem {
    return this.updateIntakeItem(id, { status: "archived" })
  }

  deleteIntakeItem(id: string): void {
    const existing = this.repo.getIntakeItem(id)
    if (!existing) throw new Error(`IntakeItem '${id}' not found`)
    this.repo.deleteIntakeItem(id)
    this.emit("intake_item_updated", { id, changes: { deleted: true } }, "system")
  }

  appendIntakeActivity(intakeItemId: string, input: {
    kind: IntakeActivity["kind"]
    actor: string
    payload: Record<string, unknown>
  }): IntakeActivity {
    const existing = this.repo.getIntakeItem(intakeItemId)
    if (!existing) throw new Error(`IntakeItem '${intakeItemId}' not found`)
    const activity: IntakeActivity = {
      id: crypto.randomUUID(),
      intakeItemId,
      kind: input.kind,
      actor: input.actor,
      payload: input.payload,
      createdAt: new Date().toISOString(),
    }
    this.repo.appendIntakeActivity(activity)
    this.emit("intake_activity_appended", activity, input.actor)
    return activity
  }

  linkExternalReference(input: {
    intakeItemId: string
    provider: string
    externalId: string
    externalUrl?: string | null
    lastKnownState?: Record<string, unknown> | null
  }): ExternalReference {
    const existing = this.repo.getIntakeItem(input.intakeItemId)
    if (!existing) throw new Error(`IntakeItem '${input.intakeItemId}' not found`)
    const reference: ExternalReference = {
      id: crypto.randomUUID(),
      intakeItemId: input.intakeItemId,
      provider: input.provider,
      externalId: input.externalId,
      externalUrl: input.externalUrl ?? null,
      lastKnownState: input.lastKnownState ?? null,
      createdAt: new Date().toISOString(),
    }
    const inserted = this.repo.insertExternalReference(reference)
    if (!inserted) throw new Error(`ExternalReference '${input.provider}:${input.externalId}' already exists`)
    this.emit("external_reference_linked", inserted, input.provider)
    return inserted
  }

  getExternalReferenceByProvider(provider: string, externalId: string): ExternalReference | undefined {
    return this.repo.getExternalReferenceByProvider(provider, externalId)
  }

  updateExternalReference(id: string, changes: Partial<Omit<ExternalReference, "id" | "createdAt">>): ExternalReference {
    const existing = this.repo.getExternalReference(id)
    if (!existing) throw new Error(`ExternalReference '${id}' not found`)
    this.repo.updateExternalReference(id, changes)
    const updated = this.repo.getExternalReference(id)!
    this.emit("external_reference_linked", updated, updated.provider)
    return updated
  }

  recordExternalEventDedup(input: {
    provider: string
    externalId: string
    externalEventId: string
  }): boolean {
    return this.repo.insertExternalEventDedup({
      ...input,
      receivedAt: new Date().toISOString(),
    })
  }

  getDecision(id: string): ReviewableDecision | undefined {
    return this.repo.getReviewableDecision(id)
  }

  listOpenDecisions(): ReviewableDecision[] {
    return this.repo.listOpenReviewableDecisions()
  }

  acceptDecision(id: string, answer?: { payload?: Record<string, unknown>; freeTextAnswer?: string }, batchId?: string): ReviewableDecision {
    const decision = this.openDecision(id)
    const payload = answer?.payload ?? decision.recommendedIntentPayload
    const now = new Date().toISOString()
    this.applyIntent(payload as unknown as Intent, "human-accepted-decision", "human")
    const resolved = {
      ...decision,
      recommendedIntentPayload: payload,
      freeTextAnswer: answer?.freeTextAnswer ?? decision.freeTextAnswer,
      status: "applied" as const,
      batchId: batchId ?? decision.batchId,
      resolvedAt: now,
    }
    this.repo.updateReviewableDecision(id, resolved)
    this.emit("decision_resolved", { ...resolved, outcome: "applied", answer: payload }, "human")
    return resolved
  }

  rejectDecision(id: string, batchId?: string): ReviewableDecision {
    const decision = this.openDecision(id)
    const resolved = {
      ...decision,
      status: "rejected" as const,
      batchId: batchId ?? decision.batchId,
      resolvedAt: new Date().toISOString(),
    }
    this.repo.updateReviewableDecision(id, resolved)
    this.emit("decision_resolved", { ...resolved, outcome: "rejected" }, "human")
    return resolved
  }

  editDecision(id: string, payload: Record<string, unknown>, freeTextAnswer?: string, batchId?: string): ReviewableDecision {
    return this.acceptDecision(id, { payload, freeTextAnswer }, batchId)
  }

  snoozeDecision(id: string, until: string): ReviewableDecision {
    const decision = this.openDecision(id)
    const snoozed = { ...decision, status: "snoozed" as const, resolvedAt: until }
    this.repo.updateReviewableDecision(id, snoozed)
    this.emit("decision_snoozed", { id, until }, "human")
    return snoozed
  }

  expireSnoozedDecisions(now = new Date().toISOString()): ReviewableDecision[] {
    return this.repo.listReviewableDecisions()
      .filter((decision) => decision.status === "snoozed" && decision.resolvedAt !== null && decision.resolvedAt <= now)
      .map((decision) => {
        const reopened = { ...decision, status: "open" as const, resolvedAt: null }
        this.repo.updateReviewableDecision(decision.id, reopened)
        this.emit("decision_expired", { id: decision.id, status: "open", resolvedAt: null }, "system")
        return reopened
      })
  }

  submitReviewBatch(input: { submittedBy?: string; answers: ReviewAnswer[] }): ReviewBatch {
    const now = new Date().toISOString()
    const batch: ReviewBatch = {
      id: crypto.randomUUID(),
      submittedBy: input.submittedBy ?? "human",
      submittedAt: null,
      createdAt: now,
    }
    this.repo.insertReviewBatch(batch)
    input.answers.map((answer) => this.openDecision(answer.decisionId))

    const submitted = { ...batch, submittedAt: now }
    input.answers.map((answer) => {
      if (answer.action === "accept") return this.acceptDecision(answer.decisionId, answer, submitted.id)
      if (answer.action === "edit") return this.editDecision(answer.decisionId, answer.payload, answer.freeTextAnswer, submitted.id)
      return this.rejectDecision(answer.decisionId, submitted.id)
    })
    this.repo.updateReviewBatch(submitted.id, submitted)
    this.emit("review_batch_submitted", submitted, submitted.submittedBy)
    return submitted
  }

  setLoadoutSlot(input: {
    scopeType: LoadoutScopeType
    scopeId: string | null
    kind: LoadoutKind
    payload: Record<string, unknown>
  }): LoadoutSlot {
    const now = new Date().toISOString()
    const existing = this.repo.listLoadoutSlotsByScope(input.scopeType, input.scopeId)
      .find((slot) => slot.kind === input.kind)
    const slot: LoadoutSlot = {
      id: existing?.id ?? crypto.randomUUID(),
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      kind: input.kind,
      payload: input.payload,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (existing) {
      this.repo.updateLoadoutSlot(existing.id, slot)
    } else {
      this.repo.insertLoadoutSlot(slot)
    }
    this.emit("loadout_slot_set", slot, "human")
    return slot
  }

  clearLoadoutSlot(id: string): void {
    const slot = this.repo.getLoadoutSlot(id)
    if (!slot) throw new Error(`LoadoutSlot '${id}' not found`)
    this.repo.deleteLoadoutSlot(id)
    this.emit("loadout_slot_cleared", { id }, "human")
  }

  resolveLoadoutSlot(subject: LoadoutSubject, kind: LoadoutKind) {
    return resolveLoadout(subject, kind, this.repo)
  }

  recordCaptainFailure(input: {
    agentRunId: string
    scratchpadId?: string
    errorClass: string
    message: string
  }): void {
    this.emit("captain_failed", input, "captain")
  }

  close(): void {
    this.repo.close()
  }

  private active(item: WorkItem) {
    return !item.archivedAt && !item.deletedAt
  }

  private hasHumanProvenance(itemId: string): boolean {
    return this.repo.getEvents().some((event) => {
      if (event.type !== "item_created" && event.type !== "item_updated") return false
      const payload = JSON.parse(event.payload) as {
        item?: { id?: string }
        id?: string
        provenance?: { actor?: string }
      }
      return (payload.item?.id === itemId || payload.id === itemId) && payload.provenance?.actor === "human"
    })
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
      const provenance = buildProvenance()
      this.emit("item_updated", { id: item.id, changes: { status: next }, provenance }, provenance.actor)
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

  private resolvePolicyRules(ctx: ProposeContext) {
    if (ctx.rules) return ctx.rules
    if (!ctx.policyName) return defaultRules
    const policy = getPolicy(ctx.policyName)
    if (!policy) throw new Error(`AutoPolicy '${ctx.policyName}' not registered`)
    return policy.defaultRules
  }

  private mergeNodes(intent: Extract<Intent, { intentKind: "merge_nodes" }>, provenance: ProvenanceInput): WorkItem {
    const target = this.repo.getItem(intent.targetNodeId)
    if (!target) throw new Error(`WorkItem '${intent.targetNodeId}' not found`)
    const sourceIds = [...new Set(intent.sourceNodeIds.filter((id) => id !== intent.targetNodeId))]
    if (sourceIds.length === 0) return target
    const missing = sourceIds.find((id) => !this.repo.getItem(id))
    if (missing) throw new Error(`WorkItem '${missing}' not found`)

    const sourceSet = new Set(sourceIds)
    const sources = sourceIds
      .map((id) => this.repo.getItem(id))
      .filter((item): item is WorkItem => item !== undefined)
    if (target.parentId && sourceSet.has(target.parentId)) {
      this.update(target.id, {
        parentId: sources.find((item) => item.id === target.parentId)?.parentId ?? null,
      }, { provenance })
    }

    const edges = this.repo.getAllEdges()
    const existing = new Set(edges.map((edge) => `${edge.source}\0${edge.target}`))
    const addIfMissing = (source: string, targetId: string) => {
      if (source === targetId) return
      const key = `${source}\0${targetId}`
      if (existing.has(key)) return
      this.addDep(source, targetId, { provenance })
      existing.add(key)
    }
    edges
      .filter((edge) => sourceSet.has(edge.target) && !sourceSet.has(edge.source) && edge.source !== target.id)
      .forEach((edge) => addIfMissing(edge.source, target.id))
    edges
      .filter((edge) => sourceSet.has(edge.source) && !sourceSet.has(edge.target) && edge.target !== target.id)
      .forEach((edge) => addIfMissing(target.id, edge.target))
    this.repo.getAllItems()
      .filter((item) => item.parentId && sourceSet.has(item.parentId) && item.id !== target.id && !sourceSet.has(item.id))
      .forEach((item) => this.update(item.id, { parentId: target.id }, { provenance }))
    sourceIds.forEach((id) => this.remove(id, { provenance }))
    return this.repo.getItem(target.id) ?? target
  }

  private splitNode(intent: Extract<Intent, { intentKind: "split_node" }>, provenance: ProvenanceInput): WorkItem {
    const source = this.repo.getItem(intent.nodeId)
    if (!source) throw new Error(`WorkItem '${intent.nodeId}' not found`)
    const newNodes = intent.newNodes ?? []
    newNodes.forEach((node) => this.create({
      sourceId: source.sourceId,
      parentId: source.id,
      repoRef: source.repoRef ?? null,
      repoLabel: source.repoLabel ?? null,
      title: node.title,
      description: node.description ?? "",
      labels: source.labels,
      provenance,
    }))
    return this.repo.getItem(source.id) ?? source
  }

  private syncSource(intent: Extract<Intent, { intentKind: "sync_source" }>, provenance: ProvenanceInput): WorkItem | undefined {
    const id = intent.sourceId ?? (intent.subjectType === "work_item" ? intent.subjectId : undefined)
    const item = id ? this.repo.getItem(id) : undefined
    if (id && !item) throw new Error(`WorkItem '${id}' not found`)
    this.emit("item_synced", {
      id: id ?? null,
      sourceId: intent.sourceId ?? null,
      externalReferenceId: intent.externalReferenceId ?? null,
      provenance,
    }, provenance.actor ?? "captain")
    return item
  }

  private applyIntent(intent: Intent, firedRuleId: string, actor: ProvenanceInput["actor"]): WorkItem | undefined {
    const provenance = buildProvenance({
      actor,
      confidence: intent.confidence,
      evidence: intent.evidenceMd,
      sourceIntakeItemId: intent.subjectType === "intake_item" ? intent.subjectId : null,
      firedRuleId,
    })

    switch (intent.intentKind) {
      case "add_node":
        return this.create({
          sourceId: intent.subjectType === "intake_item" ? intent.subjectId : undefined,
          parentId: intent.parentId ?? null,
          title: intent.title,
          description: intent.description,
          nodeType: intent.nodeType,
          labels: intent.labels,
          provenance,
        })
      case "add_edge":
        this.addDep(intent.source, intent.target, { provenance })
        return
      case "remove_edge":
        this.removeDep(intent.source, intent.target, { provenance })
        return
      case "update_status":
        return this.update(intent.nodeId, { status: intent.status }, { provenance })
      case "delete_node":
        this.remove(intent.nodeId, { provenance })
        return
      case "reparent_node":
        return this.update(intent.nodeId, { parentId: intent.parentId }, { provenance })
      case "merge_nodes":
        return this.mergeNodes(intent, provenance)
      case "split_node":
        return this.splitNode(intent, provenance)
      case "update_loadout":
        this.setLoadoutSlot({
          scopeType: intent.scopeType,
          scopeId: intent.scopeId,
          kind: intent.loadoutKind,
          payload: intent.payload,
        })
        return
      case "sync_source":
        return this.syncSource(intent, provenance)
    }
  }

  createDecision(decision: PolicyDecision, actor = "captain"): ReviewableDecision {
    const now = new Date().toISOString()
    const row: ReviewableDecision = {
      id: crypto.randomUUID(),
      kind: decision.kind,
      intentKind: decision.intentKind,
      subjectType: decision.subjectType,
      subjectId: decision.subjectId,
      promptMd: decision.promptMd,
      recommendedIntentPayload: decision.recommendedIntentPayload as unknown as Record<string, unknown>,
      alternatives: decision.alternatives.map((item) => item as unknown as Record<string, unknown>),
      freeTextAnswer: null,
      confidence: decision.confidence,
      evidenceMd: decision.evidenceMd,
      defaultAction: decision.defaultAction,
      autoApplyAllowed: decision.autoApplyAllowed,
      status: "open",
      batchId: null,
      createdBy: actor,
      createdAt: now,
      resolvedAt: null,
    }
    this.repo.insertReviewableDecision(row)
    this.emit("decision_created", row, actor)
    return row
  }

  private openDecision(id: string): ReviewableDecision {
    const decision = this.repo.getReviewableDecision(id)
    if (!decision) throw new Error(`Decision '${id}' not found`)
    if (decision.status !== "open") throw new Error("Decision is not open")
    return decision
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
