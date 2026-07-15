import { createHash } from "node:crypto"
import type BetterSqlite3 from "better-sqlite3"
import type { SessionIntakePort } from "../../application/session-intake-service"
import { assertNoSqliteWorkGraphOwnerDeletion } from "./deletion-barrier"
import { initializeWorkGraphSqliteSchema } from "./schema"
import { appendIntakeCandidateChange } from "./intake-store"

const rootId = "workgraph_default"

export function createSqliteSessionIntakePort(databaseInput: BetterSqlite3.Database): SessionIntakePort {
  const database = initializeWorkGraphSqliteSchema(databaseInput).raw()
  if (!database) throw new Error("The SQLite Session intake adapter requires a real better-sqlite3 database")
  return {
    async createUnorganized(context, input) {
      if (context.access.mode !== "owner") throw new Error("Owner access is required")
      const id = `session_intake_${hash(`${context.organizationId}\u0000${context.ownerUserId}\u0000${input.sessionId}`)}`
      return database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
        database.prepare(`
          INSERT OR IGNORE INTO wg_v2_workgraphs (organization_id, owner_user_id, id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
        `).run(context.organizationId, context.ownerUserId, rootId, input.observedAt, input.observedAt)
        const result = database.prepare(`
          INSERT OR IGNORE INTO wg_v2_intake_candidates
            (organization_id, owner_user_id, id, workgraph_id, source_view_id, candidate_kind, title, body,
             normalized_json, status, observed_revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, 'session', ?, ?, ?, 'unorganized', ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          id,
          rootId,
          input.title,
          input.body,
          JSON.stringify({
            sessionId: input.sessionId,
            idempotencyKey: input.idempotencyKey,
            ...(input.execution ? { execution: input.execution } : {}),
          }),
          String(input.observedAt),
          input.observedAt,
          input.observedAt,
        )
        if (result.changes !== 1) return "existing"
        appendIntakeCandidateChange(database, context, {
          id,
          version: 1,
          state: "unorganized",
          updatedAt: input.observedAt,
        })
        return "created"
      })()
    },
  }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}
