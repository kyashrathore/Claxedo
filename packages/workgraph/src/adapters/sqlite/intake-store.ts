import { createHash, randomUUID } from "node:crypto"
import type BetterSqlite3 from "better-sqlite3"
import { hashWorkSourceContent } from "../../application/work-source-service"
import {
  createIntakeCandidatePageCursor,
  IntakeCandidatePageSchema,
  readIntakeCandidatePageCursor,
  type AdmissionProposalID,
  type ExecutionProfileDefaults,
  type WorkGraphContext,
  type WorkSourceRevisionRef,
} from "../../contracts"
import type { ExternalIntakeCandidate, IntakeCandidate, IntakeCandidateStore, IntakeReceiptStore } from "../../application/intake-service"
import { sanitizeSourceViewFilters, type SourceView, type SourceViewStore } from "../../application/source-view-service"
import { assertNoSqliteWorkGraphOwnerDeletion } from "./deletion-barrier"
import { initializeWorkGraphSqliteSchema } from "./schema"

const rootId = "workgraph_default"

export function createSqliteIntakeStores(databaseInput: BetterSqlite3.Database): Readonly<{
  sourceViews: SourceViewStore
  candidates: IntakeCandidateStore
  receipts: IntakeReceiptStore
}> {
  const database = initializeWorkGraphSqliteSchema(databaseInput).raw()
  if (!database) throw new Error("The SQLite intake adapter requires a real better-sqlite3 database")

  const sourceViews: SourceViewStore = {
    async create(context, view) {
      requireOwner(context)
      if (view.ownerUserId !== context.ownerUserId) throw new Error("Source view owner mismatch")
      const filters = sanitizeSourceViewFilters(view.provider, view.filters)
      return database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
        ensureRoot(database, context, view.createdAt)
        database.prepare(`
          INSERT INTO wg_v2_source_views
            (organization_id, owner_user_id, id, workgraph_id, team_connection_id, provider, provider_user_id,
             filters_json, target_json, sync_policy, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          view.id,
          rootId,
          view.teamConnectionId,
          view.provider,
          view.providerUserId,
          JSON.stringify(filters),
          view.target ? JSON.stringify(view.target) : null,
          view.syncPolicy,
          view.status,
          view.createdAt,
          view.updatedAt,
        )
        return { ...view, filters }
      })()
    },
    async read(context, id) {
      return sourceView(database.prepare(`
        SELECT * FROM wg_v2_source_views WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `).get(context.organizationId, context.ownerUserId, id) as SourceViewRow | undefined)
    },
    async list(context) {
      return (database.prepare(`
        SELECT * FROM wg_v2_source_views WHERE organization_id = ? AND owner_user_id = ? ORDER BY updated_at DESC, id
      `).all(context.organizationId, context.ownerUserId) as SourceViewRow[]).map((row) => sourceView(row)!)
    },
    async update(context, id, input) {
      requireOwner(context)
      return database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
        const row = database.prepare(`
          SELECT * FROM wg_v2_source_views WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `).get(context.organizationId, context.ownerUserId, id) as SourceViewRow | undefined
        if (!row) return { ok: false as const, reason: "not_found" as const }
        const filters = sanitizeSourceViewFilters(row.provider as SourceView["provider"], input.filters)
        const current = sourceView(row)!
        const target = input.target ?? current.target
        if (row.row_version !== input.expectedVersion) {
          if (row.row_version === input.expectedVersion + 1 && sameSourceView(current, { ...input, filters, ...(target ? { target } : {}) })) {
            return { ok: true as const, view: current }
          }
          return { ok: false as const, reason: "version_conflict" as const }
        }
        const result = database.prepare(`
          UPDATE wg_v2_source_views SET
            provider_user_id = ?, filters_json = ?, target_json = ?, sync_policy = ?, status = ?,
            row_version = row_version + 1, updated_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
        `).run(
          input.providerUserId,
          JSON.stringify(filters),
          target ? JSON.stringify(target) : null,
          input.syncPolicy,
          input.status,
          input.updatedAt,
          context.organizationId, context.ownerUserId,
          id,
          input.expectedVersion,
        )
        if (result.changes !== 1) return { ok: false as const, reason: "version_conflict" as const }
        return { ok: true as const, view: sourceView(database.prepare(`
          SELECT * FROM wg_v2_source_views WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `).get(context.organizationId, context.ownerUserId, id) as SourceViewRow)! }
      })()
    },
    async delete(context, id, input) {
      requireOwner(context)
      return database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
        const row = database.prepare(`
          SELECT * FROM wg_v2_source_views WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `).get(context.organizationId, context.ownerUserId, id) as SourceViewRow | undefined
        if (!row) return { ok: false as const, reason: "not_found" as const }
        if (row.row_version !== input.expectedVersion) return { ok: false as const, reason: "version_conflict" as const }
        const retained = database.prepare(`
          SELECT 1 AS present FROM wg_v2_intake_candidates
          WHERE organization_id = ? AND owner_user_id = ? AND source_view_id = ? AND status != 'dismissed' LIMIT 1
        `).get(context.organizationId, context.ownerUserId, id)
        const admitted = database.prepare(`
          SELECT 1 AS present
          FROM wg_v2_admission_proposals proposals
          JOIN wg_v2_intake_candidates candidates
            ON candidates.organization_id = proposals.organization_id AND candidates.owner_user_id = proposals.owner_user_id AND candidates.id = proposals.intake_candidate_id
          WHERE candidates.organization_id = ? AND candidates.owner_user_id = ? AND candidates.source_view_id = ? LIMIT 1
        `).get(context.organizationId, context.ownerUserId, id)
        if (retained || admitted) return { ok: false as const, reason: "in_use" as const }
        database.prepare(`
          DELETE FROM wg_v2_external_identities
          WHERE organization_id = ? AND owner_user_id = ? AND intake_candidate_id IN (
            SELECT id FROM wg_v2_intake_candidates WHERE organization_id = ? AND owner_user_id = ? AND source_view_id = ?
          )
        `).run(context.organizationId, context.ownerUserId, context.organizationId, context.ownerUserId, id)
        database.prepare(`
          DELETE FROM wg_v2_intake_candidates WHERE organization_id = ? AND owner_user_id = ? AND source_view_id = ?
        `).run(context.organizationId, context.ownerUserId, id)
        const deleted = database.prepare(`
          DELETE FROM wg_v2_source_views WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
        `).run(context.organizationId, context.ownerUserId, id, input.expectedVersion)
        if (deleted.changes !== 1) return { ok: false as const, reason: "version_conflict" as const }
        return { ok: true as const, view: sourceView(row)! }
      })()
    },
  }

  const candidates: IntakeCandidateStore = {
    async upsertExternal(context, input) {
      requireOwner(context)
      if (input.candidate.ownerUserId !== context.ownerUserId) throw new Error("Intake candidate owner mismatch")
      return database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
        const view = database.prepare(`
          SELECT team_connection_id FROM wg_v2_source_views WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `).get(context.organizationId, context.ownerUserId, input.candidate.sourceViewId) as { team_connection_id: string } | undefined
        if (!view) throw new Error("Source view not found")
        const identity = database.prepare(`
          SELECT intake_candidate_id FROM wg_v2_external_identities
          WHERE organization_id = ? AND owner_user_id = ? AND provider = ? AND team_connection_id = ? AND external_id = ?
        `).get(context.organizationId, context.ownerUserId, input.candidate.provider, view.team_connection_id, input.candidate.externalId) as { intake_candidate_id: string | null } | undefined
        if (identity?.intake_candidate_id) {
          const existing = database.prepare(`
            SELECT normalized_json, status FROM wg_v2_intake_candidates WHERE organization_id = ? AND owner_user_id = ? AND id = ?
          `).get(context.organizationId, context.ownerUserId, identity.intake_candidate_id) as { normalized_json: string; status: string }
          const frozen = JSON.parse(existing.normalized_json) as CandidateNormalized
          if (existing.status === "unorganized" && !frozen.admissionDraft) database.prepare(`
              UPDATE wg_v2_intake_candidates SET
                source_view_id = ?, title = ?, body = ?, normalized_json = ?, observed_revision = ?,
                row_version = row_version + 1, updated_at = ?
              WHERE organization_id = ? AND owner_user_id = ? AND id = ?
            `).run(
              input.candidate.sourceViewId,
              input.candidate.title,
              input.candidate.body,
              JSON.stringify(normalized(input.candidate)),
              input.candidate.observedRevision ?? null,
              input.candidate.updatedAt,
              context.organizationId, context.ownerUserId,
              identity.intake_candidate_id,
            )
          database.prepare(`
            UPDATE wg_v2_external_identities SET external_key = ?, external_url = ?, observed_revision = ?, updated_at = ?
            WHERE organization_id = ? AND owner_user_id = ? AND provider = ? AND team_connection_id = ? AND external_id = ?
          `).run(
            input.candidate.externalKey ?? null,
            input.candidate.externalUrl ?? null,
            input.candidate.observedRevision ?? null,
            input.candidate.updatedAt,
            context.organizationId, context.ownerUserId,
            input.candidate.provider,
            view.team_connection_id,
            input.candidate.externalId,
          )
          const saved = readCandidate(database, context, identity.intake_candidate_id)
          if (saved?.candidateKind !== "external_issue") throw new Error("External identity resolved to a non-external candidate")
          return { candidate: saved, created: false }
        }
        database.prepare(`
          INSERT INTO wg_v2_intake_candidates
            (organization_id, owner_user_id, id, workgraph_id, source_view_id, candidate_kind, title, body,
             normalized_json, status, observed_revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'external_issue', ?, ?, ?, 'unorganized', ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          input.candidate.id,
          rootId,
          input.candidate.sourceViewId,
          input.candidate.title,
          input.candidate.body,
          JSON.stringify(normalized(input.candidate)),
          input.candidate.observedRevision ?? null,
          input.candidate.createdAt,
          input.candidate.updatedAt,
        )
        database.prepare(`
          INSERT INTO wg_v2_external_identities
            (organization_id, owner_user_id, id, intake_candidate_id, provider, team_connection_id, external_id,
             external_key, external_url, observed_revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          `identity_${hash(input.identityKey)}`,
          input.candidate.id,
          input.candidate.provider,
          view.team_connection_id,
          input.candidate.externalId,
          input.candidate.externalKey ?? null,
          input.candidate.externalUrl ?? null,
          input.candidate.observedRevision ?? null,
          input.candidate.createdAt,
          input.candidate.updatedAt,
        )
        return { candidate: input.candidate, created: true }
      })()
    },
    async read(context, id) {
      return readCandidate(database, context, id)
    },
    async list(context, sourceViewId) {
      const rows = sourceViewId
        ? database.prepare(`SELECT * FROM wg_v2_intake_candidates WHERE organization_id = ? AND owner_user_id = ? AND source_view_id = ? ORDER BY updated_at DESC, id`).all(context.organizationId, context.ownerUserId, sourceViewId)
        : database.prepare(`SELECT * FROM wg_v2_intake_candidates WHERE organization_id = ? AND owner_user_id = ? ORDER BY updated_at DESC, id`).all(context.organizationId, context.ownerUserId)
      return (rows as CandidateRow[]).map((row) => candidate(database, row)!)
    },
    async page(context, input) {
      requireOwner(context)
      const after = input.after
        ? readIntakeCandidatePageCursor(input.after, context.organizationId, context.ownerUserId, input.sourceViewId)
        : undefined
      const rows = database.prepare(`
        SELECT * FROM wg_v2_intake_candidates
        WHERE organization_id = @organization AND owner_user_id = @owner AND status = 'unorganized'
          AND (@source_view_id IS NULL OR source_view_id = @source_view_id)
          AND (@after_updated_at IS NULL OR updated_at < @after_updated_at
            OR (updated_at = @after_updated_at AND id < @after_id))
        ORDER BY updated_at DESC, id DESC
        LIMIT @limit
      `).all({
        organization: context.organizationId,
        owner: context.ownerUserId,
        source_view_id: input.sourceViewId ?? null,
        after_updated_at: after?.updatedAt ?? null,
        after_id: after?.candidateId ?? null,
        limit: input.limit + 1,
      }) as CandidateRow[]
      const page = rows.slice(0, input.limit).map((row) => candidate(database, row)!)
      const hasMore = rows.length > input.limit
      return IntakeCandidatePageSchema.parse({
        candidates: page,
        hasMore,
        ...(hasMore ? {
          nextCursor: createIntakeCandidatePageCursor({
            organizationId: context.organizationId,
            ownerUserId: context.ownerUserId,
            ...(input.sourceViewId ? { sourceViewId: input.sourceViewId } : {}),
            updatedAt: page.at(-1)!.updatedAt,
            candidateId: page.at(-1)!.id,
          }),
        } : {}),
      })
    },
    async prepareStage(context, id, draft) {
      requireOwner(context)
      return database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
        const row = database.prepare(`
          SELECT normalized_json, status FROM wg_v2_intake_candidates WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `).get(context.organizationId, context.ownerUserId, id) as { normalized_json: string; status: string } | undefined
        if (!row || !["unorganized", "staged"].includes(row.status)) throw new Error("Candidate cannot be staged")
        const data = JSON.parse(row.normalized_json) as CandidateNormalized
        const frozen = data.admissionDraft ?? draft
        if (!data.admissionDraft) database.prepare(`
          UPDATE wg_v2_intake_candidates SET normalized_json = ?, row_version = row_version + 1, updated_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `).run(JSON.stringify({ ...data, admissionDraft: frozen }), Date.now(), context.organizationId, context.ownerUserId, id)
        return { candidate: readCandidate(database, context, id)!, draft: frozen }
      })()
    },
    async stage(context, id, input) {
      requireOwner(context)
      return database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
        const row = database.prepare(`
          SELECT normalized_json, status FROM wg_v2_intake_candidates WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `).get(context.organizationId, context.ownerUserId, id) as { normalized_json: string; status: string } | undefined
        if (!row || !["unorganized", "staged"].includes(row.status)) throw new Error("Candidate cannot be staged")
        const data = JSON.parse(row.normalized_json) as CandidateNormalized
        if (!data.admissionDraft || hashWorkSourceContent(data.admissionDraft.content) !== input.source.contentHash) {
          throw new Error("Candidate source does not match its frozen intake evidence")
        }
        const proposal = database.prepare(`
          SELECT proposals.id
          FROM wg_v2_admission_proposals proposals
          JOIN wg_v2_work_source_revisions revisions
            ON revisions.organization_id = proposals.organization_id AND revisions.owner_user_id = proposals.owner_user_id AND revisions.id = proposals.source_revision_id
          WHERE proposals.organization_id = ? AND proposals.owner_user_id = ? AND proposals.id = ? AND proposals.lifecycle IN ('planning', 'planning_failed', 'proposed')
            AND revisions.work_source_id = ? AND revisions.id = ? AND revisions.content_hash = ?
        `).get(context.organizationId, context.ownerUserId, input.proposalId, input.source.workSourceId, input.source.revisionId, input.source.contentHash) as { id: string } | undefined
        if (!proposal) throw new Error("Admission proposal does not match the candidate source")
        const now = Date.now()
        const binding = database.prepare(`
          UPDATE wg_v2_admission_proposals SET intake_candidate_id = ?, updated_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND (intake_candidate_id IS NULL OR intake_candidate_id = ?)
        `).run(id, now, context.organizationId, context.ownerUserId, input.proposalId, id)
        if (binding.changes !== 1) throw new Error("Admission proposal is already bound to another candidate")
        const result = database.prepare(`
          UPDATE wg_v2_intake_candidates SET status = 'staged', normalized_json = ?, row_version = row_version + 1, updated_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `).run(JSON.stringify({ ...data, source: input.source, admissionProposalId: input.proposalId }), now, context.organizationId, context.ownerUserId, id)
        if (!result.changes) throw new Error("Candidate cannot be staged")
        return readCandidate(database, context, id)!
      })()
    },
    async transition(context, id, input) {
      requireOwner(context)
      return database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
        const row = database.prepare(`
          SELECT status, row_version FROM wg_v2_intake_candidates WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `).get(context.organizationId, context.ownerUserId, id) as { status: string; row_version: number } | undefined
        if (!row) return { ok: false as const, reason: "not_found" as const }
        if (row.row_version !== input.expectedVersion) {
          if (row.row_version === input.expectedVersion + 1 && row.status === input.to) {
            return { ok: true as const, candidate: readCandidate(database, context, id)! }
          }
          return { ok: false as const, reason: "version_conflict" as const }
        }
        if (row.status !== input.from) return { ok: false as const, reason: "invalid_state" as const }
        const result = database.prepare(`
          UPDATE wg_v2_intake_candidates SET status = ?, row_version = row_version + 1, updated_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ? AND status = ?
        `).run(input.to, input.updatedAt, context.organizationId, context.ownerUserId, id, input.expectedVersion, input.from)
        if (result.changes !== 1) return { ok: false as const, reason: "version_conflict" as const }
        return { ok: true as const, candidate: readCandidate(database, context, id)! }
      })()
    },
  }

  const receipts: IntakeReceiptStore = {
    async begin(context, receipt) {
      requireOwner(context)
      const operationId = `intake_sync_${hash(receipt.key)}`
      return database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
        const existing = database.prepare(`
          SELECT status, claim_expires_at FROM wg_v2_outbox WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
        `).get(context.organizationId, context.ownerUserId, receipt.key) as { status: string; claim_expires_at: number | null } | undefined
        if (existing?.status === "completed") return { state: "completed" as const }
        const now = Date.now()
        if (existing?.status === "pending" && Number(existing.claim_expires_at) > now) return { state: "busy" as const }
        const leaseId = randomUUID()
        if (existing) {
          database.prepare(`
            UPDATE wg_v2_outbox SET status = 'pending', claimed_by = ?, claim_expires_at = ?, updated_at = ?
            WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
          `).run(leaseId, now + 60_000, now, context.organizationId, context.ownerUserId, receipt.key)
          return { state: "acquired" as const, leaseId }
        }
        database.prepare(`
          INSERT INTO wg_v2_operation_results
            (organization_id, owner_user_id, id, command_type, request_hash, result_status, result_json, created_at)
          VALUES (?, ?, ?, 'intake_external_sync', ?, 200, ?, ?)
        `).run(context.organizationId, context.ownerUserId, operationId, hash(JSON.stringify(receipt)), JSON.stringify({
          ok: true,
          operationId,
          cursor: "0",
          value: { claimed: true },
        }), now)
        database.prepare(`
          INSERT INTO wg_v2_outbox
            (organization_id, owner_user_id, id, operation_id, effect_type, idempotency_key, payload_json, status, available_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'intake_external_sync', ?, ?, 'pending', ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          `intake_receipt_${hash(`${context.organizationId}\u0000${context.ownerUserId}\u0000${receipt.key}`)}`,
          operationId,
          receipt.key,
          JSON.stringify({ candidateId: receipt.candidateId, effect: receipt.effect }),
          now,
          now,
          now,
        )
        database.prepare(`
          UPDATE wg_v2_outbox SET claimed_by = ?, claim_expires_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
        `).run(leaseId, now + 60_000, context.organizationId, context.ownerUserId, receipt.key)
        return { state: "acquired" as const, leaseId }
      })()
    },
    async complete(context, receipt) {
      requireOwner(context)
      database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
        database.prepare(`
          UPDATE wg_v2_outbox SET status = 'completed', claimed_by = NULL, claim_expires_at = NULL, updated_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ? AND status = 'pending' AND claimed_by = ?
        `).run(Date.now(), context.organizationId, context.ownerUserId, receipt.key, receipt.leaseId)
      })()
    },
    async fail(context, receipt) {
      requireOwner(context)
      database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
        database.prepare(`
          UPDATE wg_v2_outbox SET status = 'failed', claimed_by = NULL, claim_expires_at = NULL, updated_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ? AND status = 'pending' AND claimed_by = ?
        `).run(Date.now(), context.organizationId, context.ownerUserId, receipt.key, receipt.leaseId)
      })()
    },
  }

  return { sourceViews, candidates, receipts }
}

function ensureRoot(database: BetterSqlite3.Database, context: WorkGraphContext, now: number) {
  database.prepare(`
    INSERT OR IGNORE INTO wg_v2_workgraphs (organization_id, owner_user_id, id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
  `).run(context.organizationId, context.ownerUserId, rootId, now, now)
}

function readCandidate(database: BetterSqlite3.Database, context: WorkGraphContext, id: string) {
  return candidate(database, database.prepare(`
    SELECT * FROM wg_v2_intake_candidates WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `).get(context.organizationId, context.ownerUserId, id) as CandidateRow | undefined)
}

function sourceView(row: SourceViewRow | undefined): SourceView | undefined {
  if (!row) return undefined
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    version: row.row_version,
    teamConnectionId: row.team_connection_id as SourceView["teamConnectionId"],
    provider: row.provider as SourceView["provider"],
    providerUserId: row.provider_user_id,
    filters: JSON.parse(row.filters_json) as Record<string, string>,
    ...(row.target_json ? { target: JSON.parse(row.target_json) as SourceView["target"] } : {}),
    syncPolicy: row.sync_policy as SourceView["syncPolicy"],
    status: row.status as SourceView["status"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function candidate(database: BetterSqlite3.Database, row: CandidateRow | undefined): IntakeCandidate | undefined {
  if (!row) return undefined
  const data = JSON.parse(row.normalized_json) as CandidateNormalized
  const confirmed = data.source && data.admissionProposalId && database.prepare(`
    SELECT proposals.id
    FROM wg_v2_admission_proposals proposals
    JOIN wg_v2_work_source_revisions revisions
      ON revisions.organization_id = proposals.organization_id AND revisions.owner_user_id = proposals.owner_user_id AND revisions.id = proposals.source_revision_id
    WHERE proposals.organization_id = ? AND proposals.owner_user_id = ? AND proposals.id = ? AND proposals.intake_candidate_id = ?
      AND proposals.lifecycle = 'confirmed' AND revisions.work_source_id = ?
      AND revisions.id = ? AND revisions.content_hash = ?
  `).get(row.organization_id, row.owner_user_id, data.admissionProposalId, row.id, data.source.workSourceId, data.source.revisionId, data.source.contentHash)
  const common = {
    id: row.id,
    ownerUserId: row.owner_user_id,
    version: row.row_version,
    title: row.title,
    body: row.body,
    ...(row.observed_revision ? { observedRevision: row.observed_revision } : {}),
    state: confirmed ? "confirmed" as const : row.status as IntakeCandidate["state"],
    ...(data.source ? { source: data.source } : {}),
    ...(data.admissionProposalId ? { admissionProposalId: data.admissionProposalId } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
  if (row.candidate_kind === "session") {
    if (!data.sessionId) throw new Error(`Session intake candidate ${row.id} is missing its Session identity`)
    return {
      ...common,
      candidateKind: "session",
      sessionId: data.sessionId,
      ...(data.execution ? { execution: data.execution } : {}),
    }
  }
  if (!row.source_view_id || !data.provider || !data.externalId || !data.externalStatus) {
    throw new Error(`External intake candidate ${row.id} is missing provider identity`)
  }
  return {
    ...common,
    candidateKind: "external_issue",
    sourceViewId: row.source_view_id,
    provider: data.provider,
    externalId: data.externalId,
    ...(data.externalKey ? { externalKey: data.externalKey } : {}),
    ...(data.externalUrl ? { externalUrl: data.externalUrl } : {}),
    externalStatus: data.externalStatus,
  }
}

function normalized(value: ExternalIntakeCandidate) {
  return {
    provider: value.provider,
    externalId: value.externalId,
    ...(value.externalKey ? { externalKey: value.externalKey } : {}),
    ...(value.externalUrl ? { externalUrl: value.externalUrl } : {}),
    externalStatus: value.externalStatus,
  }
}

function sameSourceView(view: SourceView, input: Pick<SourceView, "providerUserId" | "filters" | "target" | "syncPolicy" | "status">) {
  return view.providerUserId === input.providerUserId
    && view.syncPolicy === input.syncPolicy
    && view.status === input.status
    && JSON.stringify(view.target) === JSON.stringify(input.target)
    && Object.keys(view.filters).length === Object.keys(input.filters).length
    && Object.entries(view.filters).every(([key, value]) => input.filters[key] === value)
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function requireOwner(context: WorkGraphContext) {
  if (context.access.mode !== "owner") throw new Error("Owner access is required")
}

type SourceViewRow = Readonly<{
  owner_user_id: string
  id: string
  team_connection_id: string
  provider: string
  provider_user_id: string
  filters_json: string
  target_json: string | null
  sync_policy: string
  status: string
  row_version: number
  created_at: string | number
  updated_at: string | number
}>

type CandidateRow = Readonly<{
  organization_id: string
  owner_user_id: string
  id: string
  source_view_id: string | null
  candidate_kind: string
  title: string
  body: string
  normalized_json: string
  status: string
  observed_revision: string | null
  row_version: number
  created_at: string | number
  updated_at: string | number
}>

type CandidateNormalized = ReturnType<typeof normalized> & Readonly<{
  sessionId?: string
  execution?: ExecutionProfileDefaults
  admissionDraft?: Readonly<{ title: string; content: string }>
  source?: WorkSourceRevisionRef
  admissionProposalId?: AdmissionProposalID
}>
