import { createHash, randomUUID } from "node:crypto"
import type Database from "better-sqlite3"
import { assertNoSqliteWorkGraphOwnerDeletion } from "@claxedo/workgraph"
import type { WorkGraphConnectionOperationResponse, WorkGraphContext } from "@claxedo/workgraph/contracts"

type PullRequestResult = Extract<WorkGraphConnectionOperationResponse, { type: "open_pull_request" }>

export function createSqlitePullRequestEffects(database: Database.Database) {
  return {
    async claim(context: WorkGraphContext, input: Readonly<{
      streamId: string
      runId: string
      idempotencyKey: string
      repository: string
      head: string
      base: string
      title: string
      body?: string
      draft: boolean
      publicRepository: boolean
    }>) {
      return database.transaction(() => {
        // An external effect must never be claimed while the owner-deletion
        // barrier is active — the package-internal effect paths all assert
        // this and the PR path is no exception.
        assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
        const now = Date.now()
        const row = database.prepare(`
          SELECT id, status, payload_json, attempt_count, claim_expires_at
          FROM wg_v2_outbox
          WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
        `).get(context.organizationId, context.ownerUserId, input.idempotencyKey) as {
          id: string
          status: string
          payload_json: string
          attempt_count: number
          claim_expires_at: number | null
        } | undefined
        if (row?.status === "completed") {
          const result = (JSON.parse(row.payload_json) as { result?: PullRequestResult }).result
          if (!result) throw new Error("Completed pull request effect is missing its result")
          return { state: "completed" as const, result }
        }
        if (row?.status === "claimed" && Number(row.claim_expires_at) > now) return { state: "busy" as const }
        if (row?.status === "failed" && row.attempt_count >= 3) return { state: "failed" as const }
        const leaseId = randomUUID()
        const payload = JSON.stringify(input)
        if (row) {
          database.prepare(`
            UPDATE wg_v2_outbox
            SET payload_json = ?, status = 'claimed', claimed_by = ?, claim_expires_at = ?,
              attempt_count = attempt_count + 1, last_error = NULL, updated_at = ?
            WHERE organization_id = ? AND owner_user_id = ? AND id = ?
          `).run(payload, leaseId, now + 60_000, now, context.organizationId, context.ownerUserId, row.id)
          return { state: "claimed" as const, outboxId: row.id, leaseId }
        }
        const digest = createHash("sha256").update(input.idempotencyKey).digest("hex")
        const operationId = `pull_request_${digest}`
        const outboxId = `outbox_pr_${digest}`
        database.prepare(`
          INSERT OR IGNORE INTO wg_v2_operation_results
            (organization_id, owner_user_id, id, command_type, request_hash, result_status, result_json, created_at)
          VALUES (?, ?, ?, 'open_pull_request', ?, 200, ?, ?)
        `).run(
          context.organizationId,
          context.ownerUserId,
          operationId,
          digest,
          JSON.stringify({ ok: true, operationId, cursor: "0", value: { outboxId } }),
          now,
        )
        database.prepare(`
          INSERT INTO wg_v2_outbox
            (organization_id, owner_user_id, id, operation_id, effect_type, idempotency_key, payload_json,
             status, available_at, attempt_count, claimed_by, claim_expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'open_pull_request', ?, ?, 'claimed', ?, 1, ?, ?, ?, ?)
        `).run(
          context.organizationId,
          context.ownerUserId,
          outboxId,
          operationId,
          input.idempotencyKey,
          payload,
          now,
          leaseId,
          now + 60_000,
          now,
          now,
        )
        return { state: "claimed" as const, outboxId, leaseId }
      })()
    },
    async complete(context: WorkGraphContext, input: Readonly<{
      outboxId: string
      leaseId: string
      result: PullRequestResult
    }>) {
      return database.transaction(() => {
        const row = database.prepare(`
          SELECT status, payload_json, claimed_by FROM wg_v2_outbox
          WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `).get(context.organizationId, context.ownerUserId, input.outboxId) as {
          status: string
          payload_json: string
          claimed_by: string | null
        } | undefined
        if (!row) throw new Error("Pull request effect is unavailable")
        if (row.status === "completed") {
          const result = (JSON.parse(row.payload_json) as { result?: PullRequestResult }).result
          if (!result) throw new Error("Completed pull request effect is missing its result")
          return result
        }
        if (row.status !== "claimed" || row.claimed_by !== input.leaseId) {
          throw new Error("Pull request effect lease is no longer owned by this worker")
        }
        database.prepare(`
          UPDATE wg_v2_outbox
          SET payload_json = ?, status = 'completed', claimed_by = NULL, claim_expires_at = NULL,
            last_error = NULL, updated_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND status = 'claimed' AND claimed_by = ?
        `).run(
          JSON.stringify({ ...JSON.parse(row.payload_json), result: input.result }),
          Date.now(),
          context.organizationId,
          context.ownerUserId,
          input.outboxId,
          input.leaseId,
        )
        return input.result
      })()
    },
    async fail(context: WorkGraphContext, input: Readonly<{ outboxId: string; leaseId: string }>) {
      database.prepare(`
        UPDATE wg_v2_outbox
        SET status = CASE WHEN attempt_count >= 3 THEN 'failed' ELSE 'pending' END,
          available_at = ?, claimed_by = NULL, claim_expires_at = NULL,
          last_error = 'Pull request provider operation failed', updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND status = 'claimed' AND claimed_by = ?
      `).run(
        Date.now() + 1_000,
        Date.now(),
        context.organizationId,
        context.ownerUserId,
        input.outboxId,
        input.leaseId,
      )
    },
  }
}
