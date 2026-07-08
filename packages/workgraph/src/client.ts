/**
 * Public client — the README-contract API (plan 2026-07-06-004).
 *
 * createWorkGraph() wires the three layers behind one object:
 *   - the event-sourced item substrate (model/WorkGraph)
 *   - connections (ConnectorInterface impls + firehose queries + sync-back policy)
 *   - the flat attempt engine (sdk/attempts) driven by a bring-your-own runner
 *
 * The native `claxedo` provider is connected by default: `create()` works on a
 * fresh client with zero setup, and there is exactly ONE create for humans and
 * agents — provenance comes from the caller's identity, not separate methods.
 */

import Database from "better-sqlite3"
import { ulid } from "ulid"
import { WorkGraph } from "./model/workgraph"
import type { WorkItem, ScratchpadEntry } from "./model/types"
import type { ProvenanceInput } from "./model/provenance"
import { initializeDb } from "./db/schema"
import { sqlite, type SqliteDb } from "./sqlite"
import { openSqliteEventStore } from "./substrate/event-store-sqlite"
import { openSqliteExecutionStore, type IExecutionStore } from "./sdk/execution-store"
import { startAttempts, type SpawnAgentFn } from "./sdk/attempts"
import { createSnapshot } from "./sdk/graph-query"
import { inferRepo } from "./repo"
import { nativeConnector } from "./connectors/native"
import type { ConnectionSpec } from "./connectors/index"
import type { ConnectorInterface, ProviderParams } from "./connectors/interface"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SyncBackPolicy = "silent" | "announce" | "full"

export interface ItemFilter {
  /** "new" (mirrored, unstaged) | "staged" | "running" | "done" | raw item status */
  status?: string
  label?: string
  provider?: string
}

export interface StageOptions {
  /** Claxedo-local added context, appended to the brief before execution. */
  context?: string
  /** Loadout name recorded on the card (agent config is host-defined). */
  loadout?: string
}

export interface LaunchInput {
  item: WorkItem
  attempt: {
    runId: string
    nodeId: string
    /** Suggested worktree path; your runner may use it or return its own. */
    worktree: string
  }
  /** Source brief + staged context, ready to hand to an agent. */
  prompt: string
}

export interface LaunchResult {
  sessionId: string
  worktree?: string
  directory?: string
}

export interface ClientExecutor {
  launch(input: LaunchInput): Promise<LaunchResult>
}

export type InterruptKind = "question" | "approval" | "review" | "failure"

export interface Interrupt {
  id: string
  kind: InterruptKind
  itemId: string | null
  title: string
  detail?: string
}

export interface PolicyRule {
  when: { source?: string; label?: string; repo?: string }
  then: { stage?: boolean; loadout?: string }
}

const STAGED_LABEL = "staged"

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class WorkGraphClient {
  private wg: WorkGraph
  private db: SqliteDb
  private store: IExecutionStore
  private connections = new Map<string, { spec: ConnectionSpec; syncBack: SyncBackPolicy }>()
  private adapter: ClientExecutor | null = null
  private listeners: Array<(interrupt: Interrupt) => void> = []
  private emitted = new Set<string>()
  private announced = new Set<string>()
  private actorId: string
  private baseDirectory: string

  constructor(opts?: { db?: string; actor?: string; directory?: string }) {
    const path = opts?.db ?? ":memory:"
    this.actorId = opts?.actor ?? "user:local"
    this.baseDirectory = opts?.directory ?? process.cwd()
    this.wg = new WorkGraph(path === ":memory:" ? undefined : path)
    const raw = new Database(path)
    initializeDb(raw)
    this.db = sqlite(raw)
    this.store = openSqliteExecutionStore(this.db, openSqliteEventStore(raw))
    this.db.run(
      "CREATE TABLE IF NOT EXISTS client_policies (id TEXT PRIMARY KEY, when_json TEXT NOT NULL, then_json TEXT NOT NULL, created_at TEXT NOT NULL)",
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS client_interrupts (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)",
    )
    // The native provider is connected by default — create() needs zero setup.
    this.connections.set("claxedo", {
      spec: { provider: "claxedo", connector: nativeConnector(() => this.wg, () => this.actor()) },
      syncBack: "silent",
    })
  }

  private actor(): ProvenanceInput["actor"] {
    return this.actorId as ProvenanceInput["actor"]
  }

  /** Escape hatch: the underlying event-sourced substrate. */
  get graph(): WorkGraph {
    return this.wg
  }

  // --- Connections -----------------------------------------------------------

  async connect(spec: ConnectionSpec, opts?: { syncBack?: SyncBackPolicy }): Promise<void> {
    this.connections.set(spec.provider, { spec, syncBack: opts?.syncBack ?? "announce" })
  }

  /** Idempotent firehose mirror: pull every connection's query into the inbox. */
  async sync(): Promise<{ imported: number; updated: number }> {
    let imported = 0
    let updated = 0
    for (const { spec } of this.connections.values()) {
      if (!spec.query || !spec.connector.queryIssues) continue
      const previews = await spec.connector.queryIssues(spec.query.mode, spec.query.params)
      for (const preview of previews) {
        const key = preview.external_key ?? preview.provider_url
        const status: WorkItem["status"] =
          preview.status === "closed" ? "done" : preview.status === "in_progress" ? "in_progress" : "open"
        const existing = this.wg.getAll().find(
          (item) => item.provider === spec.provider && (item.providerMeta?.external_key ?? item.providerUrl) === key,
        )
        if (existing) {
          this.wg.update(existing.id, {
            title: preview.title,
            description: preview.description,
            status,
          }, { provenance: { actor: "system" } })
          updated += 1
        } else {
          const repo = inferRepo(spec.provider, preview.provider_meta ?? null, preview.provider_url ?? null)
          const item = this.wg.create({
            title: preview.title,
            description: preview.description,
            status,
            provider: spec.provider,
            providerMeta: { ...preview.provider_meta, external_key: preview.external_key ?? null },
            providerUrl: preview.provider_url,
            repoRef: repo?.repo_ref,
            repoLabel: repo?.repo_label,
            labels: [],
            provenance: { actor: "system" },
          })
          imported += 1
          this.applyPolicies(item)
        }
      }
    }
    return { imported, updated }
  }

  // --- Items -----------------------------------------------------------------

  /** ONE create for humans and agents — provenance is the caller's identity. */
  async create(input: { title: string; description?: string; label?: string; labels?: string[] }): Promise<WorkItem> {
    const native = this.connections.get("claxedo")!.spec.connector
    const issue = await native.createIssue!({}, { title: input.title, description: input.description ?? "" })
    const labels = [...(input.labels ?? []), ...(input.label ? [input.label] : [])]
    if (labels.length) this.wg.update(issue.id, { labels }, { provenance: { actor: this.actor() } })
    return this.wg.get(issue.id)!
  }

  items(filter?: ItemFilter): WorkItem[] {
    let list = this.wg.getAll().filter((item) => !item.deletedAt && !item.archivedAt)
    if (filter?.provider) list = list.filter((item) => item.provider === filter.provider)
    if (filter?.label) list = list.filter((item) => item.labels.includes(filter.label!))
    switch (filter?.status) {
      case undefined:
        break
      case "new":
        list = list.filter((item) => item.status === "open" && !item.labels.includes(STAGED_LABEL))
        break
      case "staged":
        list = list.filter((item) => item.status === "open" && item.labels.includes(STAGED_LABEL))
        break
      case "running":
        list = list.filter((item) => item.status === "in_progress")
        break
      case "done":
        list = list.filter((item) => item.status === "done")
        break
      default:
        list = list.filter((item) => item.status === filter!.status)
    }
    return list
  }

  /** Deliberate gate: only staged items are meant for agents. */
  async stage(itemId: string, opts?: StageOptions): Promise<WorkItem> {
    const item = this.wg.get(itemId)
    if (!item) throw new Error(`Work item '${itemId}' not found`)
    const labels = new Set(item.labels)
    labels.add(STAGED_LABEL)
    if (opts?.loadout) {
      for (const label of [...labels]) if (label.startsWith("loadout:")) labels.delete(label)
      labels.add(`loadout:${opts.loadout}`)
    }
    const context = [item.context, opts?.context].filter(Boolean).join("\n\n")
    return this.wg.update(itemId, { labels: [...labels], context: context || undefined }, { provenance: { actor: this.actor() } })
  }

  events(itemId?: string) {
    const events = this.wg.getEvents()
    if (!itemId) return events
    return events.filter((event) => {
      try {
        const payload = JSON.parse(event.payload)
        return payload.id === itemId || payload.itemId === itemId || payload.item?.id === itemId
      } catch {
        return false
      }
    })
  }

  // --- Execution ---------------------------------------------------------------

  executor(adapter: ClientExecutor): void {
    this.adapter = adapter
  }

  /** Start one attempt for a card. Retry = call start again (new attempt). */
  async start(itemId: string): Promise<{ runId: string; nodeId: string }> {
    const item = this.wg.get(itemId)
    if (!item) throw new Error(`Work item '${itemId}' not found`)
    if (!this.adapter) throw new Error("No executor configured — call wg.executor({ launch }) first")
    const runId = `run_${ulid()}`
    this.db.run(
      "INSERT INTO runs_current (run_id, goal, status) VALUES (?, ?, ?)",
      [runId, item.title, "executing"],
    )
    this.store.upsertRunExec(runId, { directory: this.baseDirectory })
    // createSnapshot returns nodeId → workItemId
    const map = createSnapshot(this.db, runId, [item])
    const nodeId = [...map.entries()].find(([, itemId]) => itemId === item.id)![0]
    await startAttempts(this.store, runId, item.title, this.spawnFn(), { graph: this.wg })
    return { runId, nodeId }
  }

  private spawnFn(): SpawnAgentFn {
    const adapter = this.adapter!
    return async (prompt, runId, nodeId) => {
      const linked = this.store.getWorkItemForNode?.(runId, nodeId)
      const item = linked ? this.wg.get(linked) : undefined
      if (!item) throw new Error(`No work item linked to node ${nodeId}`)
      const suggestion = `${this.baseDirectory}/.workgraph/worktrees/${nodeId}`
      const result = await adapter.launch({
        item,
        attempt: { runId, nodeId, worktree: suggestion },
        prompt,
      })
      return {
        id: result.sessionId,
        session_id: result.sessionId,
        runtime_type: "workspace",
        directory: result.directory ?? this.baseDirectory,
        worktree_path: result.worktree ?? suggestion,
      }
    }
  }

  // --- The needs-you loop --------------------------------------------------------

  on(event: "interrupt", listener: (interrupt: Interrupt) => void): void {
    if (event === "interrupt") this.listeners.push(listener)
  }

  /**
   * Derive pending interrupts and fire listeners for new ones. Also performs
   * sync-back for freshly-finished cards. Call on your own cadence (the HTTP
   * host polls; embedded users call it after driving sessions forward).
   */
  async poll(): Promise<Interrupt[]> {
    const fresh: Interrupt[] = []
    const push = (interrupt: Interrupt) => {
      // In-memory set is the fast path; the client_interrupts table makes the
      // dedup survive restarts (same db file → interrupts fire exactly once).
      if (this.emitted.has(interrupt.id)) return
      this.emitted.add(interrupt.id)
      const receipt = this.db.run(
        "INSERT OR IGNORE INTO client_interrupts (id, created_at) VALUES (?, ?)",
        [interrupt.id, new Date().toISOString()],
      )
      if (receipt?.changes === 0) return
      fresh.push(interrupt)
    }

    for (const decision of this.wg.listOpenDecisions()) {
      push({ id: decision.id, kind: "approval", itemId: decision.subjectId ?? null, title: decision.promptMd ?? "Approval needed" })
    }
    for (const pad of this.wg.getPendingReview()) {
      if (pad.priority === "blocking") {
        push({ id: pad.id, kind: "question", itemId: pad.workItemId, title: pad.content })
      }
    }
    const failed = this.db
      .query("SELECT n.node_id, n.run_id, n.title, i.work_item_id FROM nodes_current n LEFT JOIN run_node_items_current i ON i.run_id = n.run_id AND i.node_id = n.node_id WHERE n.status = 'failed'")
      .all() as Array<{ node_id: string; run_id: string; title: string; work_item_id: string | null }>
    for (const row of failed) {
      push({ id: `fail_${row.run_id}_${row.node_id}`, kind: "failure", itemId: row.work_item_id, title: `Attempt failed: ${row.title}` })
    }
    for (const item of this.items({ status: "done" })) {
      push({ id: `review_${item.id}`, kind: "review", itemId: item.id, title: `Done: ${item.title}` })
      await this.syncBack(item)
    }

    for (const interrupt of fresh) {
      for (const listener of this.listeners) listener(interrupt)
    }
    return fresh
  }

  /** Answer any interrupt — approval decisions or blocking questions. */
  async answer(interruptId: string, text: string): Promise<void> {
    if (this.wg.getDecision(interruptId)) {
      this.wg.acceptDecision(interruptId, { freeTextAnswer: text })
      return
    }
    const pad = this.wg.getScratchpads().find((entry: ScratchpadEntry) => entry.id === interruptId)
    if (pad) {
      this.wg.writeScratchpad({
        subjectType: pad.subjectType,
        subjectId: pad.subjectId,
        workItemId: pad.workItemId,
        kind: pad.kind,
        content: text,
        priority: "fyi",
      })
      this.wg.dismissScratchpad(pad.id)
      return
    }
    throw new Error(`Interrupt '${interruptId}' not found`)
  }

  // --- Auto-triage rules ------------------------------------------------------------

  async policy(rule: PolicyRule): Promise<void> {
    this.db.run(
      "INSERT INTO client_policies (id, when_json, then_json, created_at) VALUES (?, ?, ?, ?)",
      [`pol_${ulid()}`, JSON.stringify(rule.when), JSON.stringify(rule.then), new Date().toISOString()],
    )
  }

  private policies(): PolicyRule[] {
    const rows = this.db.query("SELECT when_json, then_json FROM client_policies").all() as Array<{ when_json: string; then_json: string }>
    return rows.map((row) => ({ when: JSON.parse(row.when_json), then: JSON.parse(row.then_json) }))
  }

  private applyPolicies(item: WorkItem): void {
    for (const rule of this.policies()) {
      if (rule.when.source && item.provider !== rule.when.source) continue
      if (rule.when.label && !item.labels.includes(rule.when.label)) continue
      if (rule.when.repo && item.repoRef !== rule.when.repo && item.repoLabel !== rule.when.repo) continue
      if (rule.then.stage) {
        void this.stage(item.id, { loadout: rule.then.loadout }).catch(() => {})
      }
    }
  }

  // --- Sync-back -----------------------------------------------------------------

  private async syncBack(item: WorkItem): Promise<void> {
    if (this.announced.has(item.id)) return
    this.announced.add(item.id)
    // Durable receipt: a restart must not re-announce a card that was already
    // synced back on a previous process (receipt scratchpad below).
    if (this.wg.getScratchpads(item.id).some((pad) => pad.content.startsWith("synced_back:"))) return
    if (!item.provider || item.provider === "claxedo") return
    const connection = this.connections.get(item.provider)
    if (!connection || connection.syncBack === "silent") return
    const connector: ConnectorInterface = connection.spec.connector
    const params = (item.providerMeta ?? {}) as ProviderParams
    try {
      await connector.addComment?.(params, `claxedo: "${item.title}" is done.`)
      if (connection.syncBack === "full") {
        await connector.updateIssue?.(params, { status: "closed" })
      }
      this.wg.writeScratchpad({
        subjectType: "run_node",
        subjectId: item.id,
        workItemId: item.id,
        kind: "executor",
        content: `synced_back: announced completion to ${item.provider}`,
        priority: "fyi",
      })
    } catch (err) {
      console.warn(`[client] sync-back to ${item.provider} failed for ${item.id}:`, err)
    }
  }

  close(): void {
    this.wg.close()
    this.db.close()
  }
}

export function createWorkGraph(opts?: { db?: string; actor?: string; directory?: string }): WorkGraphClient {
  return new WorkGraphClient(opts)
}
