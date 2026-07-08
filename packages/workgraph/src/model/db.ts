import BetterSqlite3 from "better-sqlite3"
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { eq, gt, asc, desc, and, or, isNull } from "drizzle-orm"
import { existsSync, rmSync } from "node:fs"
import type { WorkItem, WorkEdge, WorkEvent, ScratchpadEntry, ScratchpadSubjectType } from "./types"
import type { WorkGraphRepo, SyncProjection, ExternalEventDedup } from "./repo"
import {
  externalReferenceToRow,
  intakeActivityToRow,
  intakeItemToRow,
  loadoutSlotToRow,
  reviewableDecisionToRow,
  reviewBatchToRow,
  rowToExternalReference,
  rowToIntakeActivity,
  rowToIntakeItem,
  rowToLoadoutSlot,
  rowToReviewableDecision,
  rowToReviewBatch,
} from "./codecs"
import type {
  ExternalReference,
  IntakeActivity,
  IntakeItem,
  IntakeItemStatus,
  LoadoutScopeType,
  LoadoutSlot,
  ReviewBatch,
  ReviewableDecision,
} from "./types"

// To swap SQLite drivers (e.g. bun:sqlite → better-sqlite3), update the two
// imports above and this alias. The class below is unchanged.
type Db = BetterSQLite3Database
type RawDatabase = InstanceType<typeof BetterSqlite3>

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const wg_events = sqliteTable("wg_events", {
  id: text("id").primaryKey(),
  seq: integer("seq").notNull().unique(),
  type: text("type").notNull(),
  payload: text("payload").notNull(),
  actor: text("actor").notNull(),
  created_at: text("created_at").notNull(),
})

const wg_items = sqliteTable("wg_items", {
  id: text("id").primaryKey(),
  source_id: text("source_id"),
  parent_id: text("parent_id"),
  repo_ref: text("repo_ref"),
  repo_label: text("repo_label"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  node_type: text("node_type").notNull().default("task"),
  status: text("status").notNull().default("open"),
  archived_at: text("archived_at"),
  archived_reason: text("archived_reason"),
  deleted_at: text("deleted_at"),
  deleted_reason: text("deleted_reason"),
  labels: text("labels").notNull().default("[]"),
  context: text("context"),
  provider: text("provider"),
  provider_meta: text("provider_meta"),
  provider_url: text("provider_url"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
})

const wg_edges = sqliteTable("wg_edges", {
  source: text("source").notNull(),
  target: text("target").notNull(),
})

const wg_item_slices = sqliteTable("wg_item_slices", {
  item_id: text("item_id").notNull(),
  slice_id: text("slice_id").notNull(),
})

const wg_scratchpads = sqliteTable("wg_scratchpads", {
  id: text("id").primaryKey(),
  work_item_id: text("work_item_id").notNull(),
  agent_run_id: text(),
  kind: text().notNull().default("executor"),
  subject_type: text().notNull().default("run_node"),
  subject_id: text().notNull(),
  content: text("content").notNull(),
  priority: text("priority").notNull().default("fyi"),
  needs_review: integer("needs_review").notNull().default(0),
  promoted_to_item_id: text("promoted_to_item_id"),
  dismissed_at: text("dismissed_at"),
  actor: text("actor").notNull(),
  created_at: text("created_at").notNull(),
})

const wg_sync_projection = sqliteTable("wg_sync_projection", {
  binding_key: text("binding_key").primaryKey(),
  provider: text("provider").notNull(),
  provider_meta: text("provider_meta").notNull(),
  last_status: text("last_status"),
  blocked_hash: text("blocked_hash"),
  archive_hash: text("archive_hash"),
  last_synced_at: text("last_synced_at"),
})

const wg_intake_items = sqliteTable("wg_intake_items", {
  id: text().primaryKey(),
  kind: text().notNull(),
  title: text(),
  body_md: text().notNull(),
  status: text().notNull().default("captured"),
  repo_ref: text(),
  triage_mode_override: text(),
  linked_session_id: text(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
  last_triaged_at: text(),
})

const wg_intake_activities = sqliteTable("wg_intake_activities", {
  id: text().primaryKey(),
  intake_item_id: text().notNull(),
  kind: text().notNull(),
  actor: text().notNull(),
  payload_json: text().notNull(),
  created_at: text().notNull(),
})

const wg_external_references = sqliteTable("wg_external_references", {
  id: text().primaryKey(),
  intake_item_id: text().notNull(),
  provider: text().notNull(),
  external_id: text().notNull(),
  external_url: text(),
  last_known_state_json: text(),
  created_at: text().notNull(),
})

const wg_external_event_dedup = sqliteTable("wg_external_event_dedup", {
  provider: text().notNull(),
  external_id: text().notNull(),
  external_event_id: text().notNull(),
  received_at: text().notNull(),
})

const wg_reviewable_decisions = sqliteTable("wg_reviewable_decisions", {
  id: text().primaryKey(),
  kind: text().notNull(),
  intent_kind: text().notNull(),
  subject_type: text().notNull(),
  subject_id: text().notNull(),
  prompt_md: text().notNull(),
  recommended_intent_payload_json: text().notNull(),
  alternatives_json: text().notNull(),
  free_text_answer: text(),
  confidence: integer().notNull(),
  evidence_md: text().notNull(),
  default_action: text().notNull(),
  auto_apply_allowed: integer().notNull().default(0),
  status: text().notNull().default("open"),
  batch_id: text(),
  created_by: text().notNull(),
  created_at: text().notNull(),
  resolved_at: text(),
})

const wg_review_batches = sqliteTable("wg_review_batches", {
  id: text().primaryKey(),
  submitted_by: text().notNull(),
  submitted_at: text(),
  created_at: text().notNull(),
})

const wg_loadout_slots = sqliteTable("wg_loadout_slots", {
  id: text().primaryKey(),
  scope_type: text().notNull(),
  scope_id: text(),
  kind: text().notNull(),
  payload_json: text().notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
})

// ---------------------------------------------------------------------------
// SQLite implementation of WorkGraphRepo
// ---------------------------------------------------------------------------

class SqliteWorkGraphRepo implements WorkGraphRepo {
  constructor(private db: Db, private raw: RawDatabase) {}

  close(): void {
    this.raw.close()
  }

  // Events

  insertEvent(event: WorkEvent): void {
    this.db.insert(wg_events).values({
      id: event.id,
      seq: event.seq,
      type: event.type,
      payload: event.payload,
      actor: event.actor,
      created_at: event.createdAt,
    }).run()
  }

  getEvents(sinceSeq?: number): WorkEvent[] {
    const rows = sinceSeq != null
      ? this.db.select().from(wg_events).where(gt(wg_events.seq, sinceSeq)).orderBy(asc(wg_events.seq)).all()
      : this.db.select().from(wg_events).orderBy(asc(wg_events.seq)).all()
    return rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      type: row.type as WorkEvent["type"],
      payload: row.payload,
      actor: row.actor,
      createdAt: row.created_at,
    }))
  }

  getMaxSeq(): number {
    const row = this.db.select({ seq: wg_events.seq }).from(wg_events).orderBy(asc(wg_events.seq)).all().at(-1)
    return row?.seq ?? 0
  }

  // Items

  insertItem(item: WorkItem): void {
    this.db.insert(wg_items).values({
      id: item.id,
      source_id: item.sourceId ?? null,
      parent_id: item.parentId ?? null,
      repo_ref: item.repoRef ?? null,
      repo_label: item.repoLabel ?? null,
      title: item.title,
      description: item.description,
      node_type: item.nodeType,
      status: item.status,
      archived_at: item.archivedAt ?? null,
      archived_reason: item.archivedReason ?? null,
      deleted_at: item.deletedAt ?? null,
      deleted_reason: item.deletedReason ?? null,
      labels: JSON.stringify(item.labels),
      context: item.context ?? null,
      provider: item.provider ?? null,
      provider_meta: item.providerMeta ? JSON.stringify(item.providerMeta) : null,
      provider_url: item.providerUrl ?? null,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
    }).run()
    if (item.sourceId) this.linkItemSlice(item.id, item.sourceId)
  }

  updateItem(id: string, changes: Omit<Partial<WorkItem>, "updatedAt">): void {
    this.db.update(wg_items).set({
      source_id: changes.sourceId,
      parent_id: changes.parentId,
      repo_ref: changes.repoRef,
      repo_label: changes.repoLabel,
      title: changes.title,
      description: changes.description,
      node_type: changes.nodeType,
      status: changes.status,
      archived_at: changes.archivedAt,
      archived_reason: changes.archivedReason,
      deleted_at: changes.deletedAt,
      deleted_reason: changes.deletedReason,
      labels: changes.labels !== undefined ? JSON.stringify(changes.labels) : undefined,
      context: changes.context,
      provider: changes.provider,
      provider_meta: changes.providerMeta !== undefined ? JSON.stringify(changes.providerMeta) : undefined,
      provider_url: changes.providerUrl,
      updated_at: new Date().toISOString(),
    }).where(eq(wg_items.id, id)).run()
    if (changes.sourceId) this.linkItemSlice(id, changes.sourceId)
  }

  deleteItem(id: string): void {
    this.db.delete(wg_edges).where(or(eq(wg_edges.source, id), eq(wg_edges.target, id))).run()
    this.db.delete(wg_item_slices).where(eq(wg_item_slices.item_id, id)).run()
  }

  getItem(id: string): WorkItem | undefined {
    const row = this.db.select().from(wg_items).where(eq(wg_items.id, id)).get()
    return row ? rowToItem(row) : undefined
  }

  getAllItems(): WorkItem[] {
    return this.db.select().from(wg_items).orderBy(asc(wg_items.created_at)).all().map(rowToItem)
  }

  // Edges

  insertEdge(source: string, target: string): void {
    this.db.insert(wg_edges).values({ source, target }).run()
  }

  deleteEdge(source: string, target: string): void {
    this.db.delete(wg_edges).where(and(eq(wg_edges.source, source), eq(wg_edges.target, target))).run()
  }

  getAllEdges(): WorkEdge[] {
    return this.db.select().from(wg_edges).all().map((r) => ({ source: r.source, target: r.target }))
  }

  // Slices

  linkItemSlice(itemId: string, sliceId: string): void {
    this.db.insert(wg_item_slices).values({ item_id: itemId, slice_id: sliceId }).onConflictDoNothing().run()
  }

  clearItemSlices(itemId: string): void {
    this.db.delete(wg_item_slices).where(eq(wg_item_slices.item_id, itemId)).run()
  }

  getItemSlices(itemId: string): string[] {
    return this.db.select({ slice_id: wg_item_slices.slice_id })
      .from(wg_item_slices)
      .where(eq(wg_item_slices.item_id, itemId))
      .orderBy(asc(wg_item_slices.slice_id))
      .all()
      .map((r) => r.slice_id)
  }

  getSliceItems(sliceId: string): string[] {
    return this.db.select({ item_id: wg_item_slices.item_id })
      .from(wg_item_slices)
      .where(eq(wg_item_slices.slice_id, sliceId))
      .orderBy(asc(wg_item_slices.item_id))
      .all()
      .map((r) => r.item_id)
  }

  // Scratchpads

  insertScratchpad(entry: ScratchpadEntry): void {
    this.db.insert(wg_scratchpads).values({
      id: entry.id,
      work_item_id: entry.workItemId,
      agent_run_id: entry.agentRunId ?? null,
      kind: entry.kind ?? "executor",
      subject_type: entry.subjectType,
      subject_id: entry.subjectId,
      content: entry.content,
      priority: entry.priority,
      needs_review: entry.needsReview ? 1 : 0,
      promoted_to_item_id: entry.promotedToItemId ?? null,
      dismissed_at: entry.dismissedAt ?? null,
      actor: entry.actor,
      created_at: entry.createdAt,
    }).run()
  }

  updateScratchpad(id: string, changes: Partial<ScratchpadEntry>): void {
    this.db.update(wg_scratchpads).set({
      promoted_to_item_id: changes.promotedToItemId,
      dismissed_at: changes.dismissedAt,
    }).where(eq(wg_scratchpads.id, id)).run()
  }

  getScratchpadsByItem(workItemId: string): ScratchpadEntry[] {
    return this.db.select().from(wg_scratchpads)
      .where(or(
        eq(wg_scratchpads.work_item_id, workItemId),
        and(eq(wg_scratchpads.subject_type, "run_node"), eq(wg_scratchpads.subject_id, workItemId)),
      ))
      .orderBy(asc(wg_scratchpads.created_at))
      .all()
      .map(rowToScratchpad)
  }

  getScratchpadsBySubject(subjectType: string, subjectId: string): ScratchpadEntry[] {
    return this.db.select().from(wg_scratchpads)
      .where(and(eq(wg_scratchpads.subject_type, subjectType), eq(wg_scratchpads.subject_id, subjectId)))
      .orderBy(asc(wg_scratchpads.created_at))
      .all()
      .map(rowToScratchpad)
  }

  getScratchpadsNeedingReview(): ScratchpadEntry[] {
    return this.db.select().from(wg_scratchpads)
      .where(and(
        eq(wg_scratchpads.needs_review, 1),
        isNull(wg_scratchpads.promoted_to_item_id),
        isNull(wg_scratchpads.dismissed_at),
      ))
      .orderBy(asc(wg_scratchpads.created_at))
      .all()
      .map(rowToScratchpad)
  }

  getAllScratchpads(): ScratchpadEntry[] {
    return this.db.select().from(wg_scratchpads).orderBy(asc(wg_scratchpads.created_at)).all().map(rowToScratchpad)
  }

  getScratchpad(id: string): ScratchpadEntry | undefined {
    const row = this.db.select().from(wg_scratchpads).where(eq(wg_scratchpads.id, id)).get()
    return row ? rowToScratchpad(row) : undefined
  }

  getLatestScratchpadByRun(agentRunId: string): ScratchpadEntry | undefined {
    const row = this.db.select().from(wg_scratchpads)
      .where(eq(wg_scratchpads.agent_run_id, agentRunId))
      .orderBy(desc(wg_scratchpads.created_at))
      .get()
    return row ? rowToScratchpad(row) : undefined
  }

  // Intake

  insertIntakeItem(item: IntakeItem): void {
    this.db.insert(wg_intake_items).values(intakeItemToRow(item)).run()
  }

  updateIntakeItem(id: string, changes: Partial<Omit<IntakeItem, "id" | "createdAt">>): void {
    this.db.update(wg_intake_items).set({
      kind: changes.kind,
      title: changes.title,
      body_md: changes.bodyMd,
      status: changes.status,
      repo_ref: changes.repoRef,
      triage_mode_override: changes.triageModeOverride,
      linked_session_id: changes.linkedSessionId,
      updated_at: changes.updatedAt ?? new Date().toISOString(),
      last_triaged_at: changes.lastTriagedAt,
    }).where(eq(wg_intake_items.id, id)).run()
  }

  deleteIntakeItem(id: string): void {
    this.raw.prepare("DELETE FROM wg_loadout_slots WHERE scope_type = 'intake_item' AND scope_id = ?").run(id)
    this.raw.prepare("DELETE FROM wg_reviewable_decisions WHERE subject_type = 'intake_item' AND subject_id = ?").run(id)
    this.raw.prepare("DELETE FROM wg_scratchpads WHERE subject_type = 'intake_item' AND subject_id = ?").run(id)
    this.raw.prepare("DELETE FROM wg_external_references WHERE intake_item_id = ?").run(id)
    this.raw.prepare("DELETE FROM wg_intake_activities WHERE intake_item_id = ?").run(id)
    this.raw.prepare("DELETE FROM wg_intake_items WHERE id = ?").run(id)
  }

  getIntakeItem(id: string): IntakeItem | undefined {
    const row = this.db.select().from(wg_intake_items).where(eq(wg_intake_items.id, id)).get()
    return row ? rowToIntakeItem(row) : undefined
  }

  listIntakeItems(): IntakeItem[] {
    return this.db.select().from(wg_intake_items).orderBy(asc(wg_intake_items.created_at)).all().map(rowToIntakeItem)
  }

  listIntakeItemsByStatus(status: IntakeItemStatus): IntakeItem[] {
    return this.db.select().from(wg_intake_items)
      .where(eq(wg_intake_items.status, status))
      .orderBy(asc(wg_intake_items.created_at))
      .all()
      .map(rowToIntakeItem)
  }

  appendIntakeActivity(activity: IntakeActivity): void {
    this.db.insert(wg_intake_activities).values(intakeActivityToRow(activity)).run()
  }

  listIntakeActivities(intakeItemId: string): IntakeActivity[] {
    return this.db.select().from(wg_intake_activities)
      .where(eq(wg_intake_activities.intake_item_id, intakeItemId))
      .orderBy(asc(wg_intake_activities.created_at))
      .all()
      .map(rowToIntakeActivity)
  }

  // External references

  insertExternalReference(reference: ExternalReference): ExternalReference | null {
    if (this.getExternalReferenceByProvider(reference.provider, reference.externalId)) return null
    this.db.insert(wg_external_references).values(externalReferenceToRow(reference)).run()
    return reference
  }

  updateExternalReference(id: string, changes: Partial<Omit<ExternalReference, "id" | "createdAt">>): void {
    this.db.update(wg_external_references).set({
      intake_item_id: changes.intakeItemId,
      provider: changes.provider,
      external_id: changes.externalId,
      external_url: changes.externalUrl,
      last_known_state_json: changes.lastKnownState !== undefined ? JSON.stringify(changes.lastKnownState) : undefined,
    }).where(eq(wg_external_references.id, id)).run()
  }

  getExternalReference(id: string): ExternalReference | undefined {
    const row = this.db.select().from(wg_external_references).where(eq(wg_external_references.id, id)).get()
    return row ? rowToExternalReference(row) : undefined
  }

  getExternalReferenceByProvider(provider: string, externalId: string): ExternalReference | undefined {
    const row = this.db.select().from(wg_external_references)
      .where(and(eq(wg_external_references.provider, provider), eq(wg_external_references.external_id, externalId)))
      .get()
    return row ? rowToExternalReference(row) : undefined
  }

  listExternalReferences(intakeItemId: string): ExternalReference[] {
    return this.db.select().from(wg_external_references)
      .where(eq(wg_external_references.intake_item_id, intakeItemId))
      .orderBy(asc(wg_external_references.created_at))
      .all()
      .map(rowToExternalReference)
  }

  insertExternalEventDedup(input: ExternalEventDedup): boolean {
    return this.raw.prepare(`
      INSERT OR IGNORE INTO wg_external_event_dedup (provider, external_id, external_event_id, received_at)
      VALUES (?, ?, ?, ?)
    `).run(input.provider, input.externalId, input.externalEventId, input.receivedAt).changes === 1
  }

  // Review

  insertReviewableDecision(decision: ReviewableDecision): void {
    this.db.insert(wg_reviewable_decisions).values(reviewableDecisionToRow(decision)).run()
  }

  updateReviewableDecision(id: string, changes: Partial<Omit<ReviewableDecision, "id" | "createdAt">>): void {
    this.db.update(wg_reviewable_decisions).set({
      kind: changes.kind,
      intent_kind: changes.intentKind,
      subject_type: changes.subjectType,
      subject_id: changes.subjectId,
      prompt_md: changes.promptMd,
      recommended_intent_payload_json: changes.recommendedIntentPayload !== undefined ? JSON.stringify(changes.recommendedIntentPayload) : undefined,
      alternatives_json: changes.alternatives !== undefined ? JSON.stringify(changes.alternatives) : undefined,
      free_text_answer: changes.freeTextAnswer,
      confidence: changes.confidence,
      evidence_md: changes.evidenceMd,
      default_action: changes.defaultAction,
      auto_apply_allowed: changes.autoApplyAllowed === undefined ? undefined : changes.autoApplyAllowed ? 1 : 0,
      status: changes.status,
      batch_id: changes.batchId,
      created_by: changes.createdBy,
      resolved_at: changes.resolvedAt,
    }).where(eq(wg_reviewable_decisions.id, id)).run()
  }

  getReviewableDecision(id: string): ReviewableDecision | undefined {
    const row = this.db.select().from(wg_reviewable_decisions).where(eq(wg_reviewable_decisions.id, id)).get()
    return row ? rowToReviewableDecision(row) : undefined
  }

  listReviewableDecisions(): ReviewableDecision[] {
    return this.db.select().from(wg_reviewable_decisions)
      .orderBy(asc(wg_reviewable_decisions.created_at))
      .all()
      .map(rowToReviewableDecision)
  }

  listReviewableDecisionsBySubject(subjectType: string, subjectId: string): ReviewableDecision[] {
    return this.db.select().from(wg_reviewable_decisions)
      .where(and(eq(wg_reviewable_decisions.subject_type, subjectType), eq(wg_reviewable_decisions.subject_id, subjectId)))
      .orderBy(asc(wg_reviewable_decisions.created_at))
      .all()
      .map(rowToReviewableDecision)
  }

  listOpenReviewableDecisions(): ReviewableDecision[] {
    return this.db.select().from(wg_reviewable_decisions)
      .where(eq(wg_reviewable_decisions.status, "open"))
      .orderBy(asc(wg_reviewable_decisions.created_at))
      .all()
      .map(rowToReviewableDecision)
  }

  insertReviewBatch(batch: ReviewBatch): void {
    this.db.insert(wg_review_batches).values(reviewBatchToRow(batch)).run()
  }

  updateReviewBatch(id: string, changes: Partial<Omit<ReviewBatch, "id" | "createdAt">>): void {
    this.db.update(wg_review_batches).set({
      submitted_by: changes.submittedBy,
      submitted_at: changes.submittedAt,
    }).where(eq(wg_review_batches.id, id)).run()
  }

  getReviewBatch(id: string): ReviewBatch | undefined {
    const row = this.db.select().from(wg_review_batches).where(eq(wg_review_batches.id, id)).get()
    return row ? rowToReviewBatch(row) : undefined
  }

  listReviewBatches(): ReviewBatch[] {
    return this.db.select().from(wg_review_batches)
      .orderBy(asc(wg_review_batches.created_at))
      .all()
      .map(rowToReviewBatch)
  }

  // Loadout

  insertLoadoutSlot(slot: LoadoutSlot): void {
    this.db.insert(wg_loadout_slots).values(loadoutSlotToRow(slot)).run()
  }

  updateLoadoutSlot(id: string, changes: Partial<Omit<LoadoutSlot, "id" | "createdAt">>): void {
    this.db.update(wg_loadout_slots).set({
      scope_type: changes.scopeType,
      scope_id: changes.scopeId,
      kind: changes.kind,
      payload_json: changes.payload !== undefined ? JSON.stringify(changes.payload) : undefined,
      updated_at: changes.updatedAt ?? new Date().toISOString(),
    }).where(eq(wg_loadout_slots.id, id)).run()
  }

  deleteLoadoutSlot(id: string): void {
    this.db.delete(wg_loadout_slots).where(eq(wg_loadout_slots.id, id)).run()
  }

  getLoadoutSlot(id: string): LoadoutSlot | undefined {
    const row = this.db.select().from(wg_loadout_slots).where(eq(wg_loadout_slots.id, id)).get()
    return row ? rowToLoadoutSlot(row) : undefined
  }

  listLoadoutSlots(): LoadoutSlot[] {
    return this.db.select().from(wg_loadout_slots)
      .orderBy(asc(wg_loadout_slots.created_at))
      .all()
      .map(rowToLoadoutSlot)
  }

  listLoadoutSlotsByScope(scopeType: LoadoutScopeType, scopeId: string | null): LoadoutSlot[] {
    return this.db.select().from(wg_loadout_slots)
      .where(and(
        eq(wg_loadout_slots.scope_type, scopeType),
        scopeId === null ? isNull(wg_loadout_slots.scope_id) : eq(wg_loadout_slots.scope_id, scopeId),
      ))
      .orderBy(asc(wg_loadout_slots.created_at))
      .all()
      .map(rowToLoadoutSlot)
  }

  // Sync projection

  getSyncProjection(key: string): SyncProjection | undefined {
    const row = this.db.select().from(wg_sync_projection).where(eq(wg_sync_projection.binding_key, key)).get()
    if (!row) return
    return {
      bindingKey: row.binding_key,
      provider: row.provider,
      providerMeta: JSON.parse(row.provider_meta),
      lastStatus: row.last_status ?? undefined,
      blockedHash: row.blocked_hash ?? undefined,
      archiveHash: row.archive_hash ?? undefined,
      lastSyncedAt: row.last_synced_at ?? undefined,
    }
  }

  upsertSyncProjection(input: Omit<SyncProjection, "lastSyncedAt">): void {
    this.db.insert(wg_sync_projection).values({
      binding_key: input.bindingKey,
      provider: input.provider,
      provider_meta: JSON.stringify(input.providerMeta),
      last_status: input.lastStatus ?? null,
      blocked_hash: input.blockedHash ?? null,
      archive_hash: input.archiveHash ?? null,
      last_synced_at: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: wg_sync_projection.binding_key,
      set: {
        provider: input.provider,
        provider_meta: JSON.stringify(input.providerMeta),
        last_status: input.lastStatus ?? null,
        blocked_hash: input.blockedHash ?? null,
        archive_hash: input.archiveHash ?? null,
        last_synced_at: new Date().toISOString(),
      },
    }).run()
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function openSqlite(path?: string): WorkGraphRepo {
  const fresh = !!path && !existsSync(path)
  try {
    const next = boot(path)
    return new SqliteWorkGraphRepo(next.db, next.raw)
  } catch (err) {
    if (!path || !fresh || !retry(err)) throw err
    wipe(path)
    const next = boot(path)
    return new SqliteWorkGraphRepo(next.db, next.raw)
  }
}

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

function boot(path?: string): { db: Db; raw: RawDatabase } {
  const sqlite = new BetterSqlite3(path ?? ":memory:")
  try {
    sqlite.exec("PRAGMA journal_mode = WAL")
    sqlite.exec("PRAGMA foreign_keys = ON")

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_events (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_items (
        id TEXT PRIMARY KEY,
        source_id TEXT,
        parent_id TEXT,
        repo_ref TEXT,
        repo_label TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        node_type TEXT NOT NULL DEFAULT 'task',
        status TEXT NOT NULL DEFAULT 'open',
        archived_at TEXT,
        archived_reason TEXT,
        deleted_at TEXT,
        deleted_reason TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        context TEXT,
        provider TEXT,
        provider_meta TEXT,
        provider_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    ensureColumn(sqlite, "wg_items", "source_id", "ALTER TABLE wg_items ADD COLUMN source_id TEXT")
    ensureColumn(sqlite, "wg_items", "parent_id", "ALTER TABLE wg_items ADD COLUMN parent_id TEXT")
    ensureColumn(sqlite, "wg_items", "repo_ref", "ALTER TABLE wg_items ADD COLUMN repo_ref TEXT")
    ensureColumn(sqlite, "wg_items", "repo_label", "ALTER TABLE wg_items ADD COLUMN repo_label TEXT")
    ensureColumn(sqlite, "wg_items", "node_type", "ALTER TABLE wg_items ADD COLUMN node_type TEXT NOT NULL DEFAULT 'task'")
    ensureColumn(sqlite, "wg_items", "archived_at", "ALTER TABLE wg_items ADD COLUMN archived_at TEXT")
    ensureColumn(sqlite, "wg_items", "archived_reason", "ALTER TABLE wg_items ADD COLUMN archived_reason TEXT")
    ensureColumn(sqlite, "wg_items", "deleted_at", "ALTER TABLE wg_items ADD COLUMN deleted_at TEXT")
    ensureColumn(sqlite, "wg_items", "deleted_reason", "ALTER TABLE wg_items ADD COLUMN deleted_reason TEXT")

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_edges (
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        PRIMARY KEY (source, target)
      )
    `)
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_item_slices (
        item_id TEXT NOT NULL,
        slice_id TEXT NOT NULL,
        PRIMARY KEY (item_id, slice_id)
      )
    `)
    sqlite.exec(`
      INSERT OR IGNORE INTO wg_item_slices (item_id, slice_id)
      SELECT id, source_id FROM wg_items WHERE source_id IS NOT NULL
    `)
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_scratchpads (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        agent_run_id TEXT,
        kind TEXT NOT NULL DEFAULT 'executor',
        subject_type TEXT NOT NULL DEFAULT 'run_node',
        subject_id TEXT,
        content TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'fyi',
        needs_review INTEGER NOT NULL DEFAULT 0,
        promoted_to_item_id TEXT,
        dismissed_at TEXT,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    ensureColumn(sqlite, "wg_scratchpads", "agent_run_id", "ALTER TABLE wg_scratchpads ADD COLUMN agent_run_id TEXT")
    ensureColumn(sqlite, "wg_scratchpads", "kind", "ALTER TABLE wg_scratchpads ADD COLUMN kind TEXT NOT NULL DEFAULT 'executor'")
    ensureColumn(sqlite, "wg_scratchpads", "subject_type", "ALTER TABLE wg_scratchpads ADD COLUMN subject_type TEXT NOT NULL DEFAULT 'run_node'")
    ensureColumn(sqlite, "wg_scratchpads", "subject_id", "ALTER TABLE wg_scratchpads ADD COLUMN subject_id TEXT")
    sqlite.exec("UPDATE wg_scratchpads SET subject_type = 'run_node', subject_id = work_item_id WHERE subject_id IS NULL")
    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS wg_scratchpads_agent_run_id_unique
      ON wg_scratchpads (agent_run_id)
      WHERE agent_run_id IS NOT NULL
    `)
    sqlite.exec("CREATE INDEX IF NOT EXISTS wg_scratchpads_subject_idx ON wg_scratchpads (subject_type, subject_id)")
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_intake_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT,
        body_md TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'captured',
        repo_ref TEXT,
        triage_mode_override TEXT,
        linked_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_triaged_at TEXT
      )
    `)
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_intake_activities (
        id TEXT PRIMARY KEY,
        intake_item_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (intake_item_id) REFERENCES wg_intake_items(id)
      )
    `)
    sqlite.exec("CREATE INDEX IF NOT EXISTS wg_intake_activities_item_created_idx ON wg_intake_activities (intake_item_id, created_at)")
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_external_references (
        id TEXT PRIMARY KEY,
        intake_item_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        external_url TEXT,
        last_known_state_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (provider, external_id),
        FOREIGN KEY (intake_item_id) REFERENCES wg_intake_items(id)
      )
    `)
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_external_event_dedup (
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        external_event_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (provider, external_id, external_event_id)
      )
    `)
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_reviewable_decisions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        intent_kind TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        prompt_md TEXT NOT NULL,
        recommended_intent_payload_json TEXT NOT NULL,
        alternatives_json TEXT NOT NULL,
        free_text_answer TEXT,
        confidence INTEGER NOT NULL,
        evidence_md TEXT NOT NULL,
        default_action TEXT NOT NULL,
        auto_apply_allowed INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        batch_id TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      )
    `)
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_review_batches (
        id TEXT PRIMARY KEY,
        submitted_by TEXT NOT NULL,
        submitted_at TEXT,
        created_at TEXT NOT NULL
      )
    `)
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_loadout_slots (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL,
        scope_id TEXT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    sqlite.exec("CREATE INDEX IF NOT EXISTS wg_loadout_slots_scope_kind_idx ON wg_loadout_slots (scope_type, scope_id, kind)")
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_sync_projection (
        binding_key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_meta TEXT NOT NULL,
        last_status TEXT,
        blocked_hash TEXT,
        archive_hash TEXT,
        last_synced_at TEXT
      )
    `)

    return { db: drizzle(sqlite), raw: sqlite }
  } catch (err) {
    try { sqlite.close() } catch {}
    throw err
  }
}

function retry(err: unknown) {
  const txt = err instanceof Error ? err.message : String(err)
  return txt.includes("SQLITE_IOERR_SHORT_READ") || txt.includes("disk I/O error")
}

function wipe(path: string) {
  try { rmSync(path, { force: true }) } catch {}
  try { rmSync(`${path}-shm`, { force: true }) } catch {}
  try { rmSync(`${path}-wal`, { force: true }) } catch {}
}

function ensureColumn(db: RawDatabase, table: string, col: string, sql: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (rows.some((row) => row.name === col)) return
  db.exec(sql)
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToItem(row: typeof wg_items.$inferSelect): WorkItem {
  return {
    id: row.id,
    sourceId: row.source_id ?? undefined,
    parentId: row.parent_id ?? null,
    repoRef: row.repo_ref ?? null,
    repoLabel: row.repo_label ?? null,
    title: row.title,
    description: row.description,
    nodeType: (row.node_type ?? "task") as WorkItem["nodeType"],
    status: row.status as WorkItem["status"],
    archivedAt: row.archived_at ?? undefined,
    archivedReason: row.archived_reason ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
    deletedReason: row.deleted_reason ?? undefined,
    labels: JSON.parse(row.labels),
    context: row.context ?? undefined,
    provider: row.provider ?? undefined,
    providerMeta: row.provider_meta ? JSON.parse(row.provider_meta) : undefined,
    providerUrl: row.provider_url ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToScratchpad(row: typeof wg_scratchpads.$inferSelect): ScratchpadEntry {
  const subjectType = (row.subject_type ?? "run_node") as ScratchpadSubjectType
  const subjectId = row.subject_id ?? row.work_item_id
  return {
    id: row.id,
    subjectType,
    subjectId,
    workItemId: row.work_item_id,
    agentRunId: row.agent_run_id ?? undefined,
    kind: (row.kind ?? "executor") as ScratchpadEntry["kind"],
    content: row.content,
    priority: row.priority as ScratchpadEntry["priority"],
    needsReview: row.needs_review === 1,
    promotedToItemId: row.promoted_to_item_id ?? undefined,
    dismissedAt: row.dismissed_at ?? undefined,
    actor: row.actor,
    createdAt: row.created_at,
  }
}
