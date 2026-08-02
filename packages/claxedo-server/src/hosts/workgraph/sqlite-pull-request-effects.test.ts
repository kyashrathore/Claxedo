import Database from "better-sqlite3"
import { initializeWorkGraphSqliteSchema } from "@claxedo/workgraph"
import type { WorkGraphContext } from "@claxedo/workgraph/contracts"
import { afterEach, describe, expect, test } from "vitest"
import { createSqlitePullRequestEffects } from "./sqlite-pull-request-effects"

const databases: Database.Database[] = []

afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("SQLite pull request effect outbox", () => {
  test("leases one idempotent effect, reclaims expiration, and replays the durable result", async () => {
    const database = new Database(":memory:")
    databases.push(database)
    initializeWorkGraphSqliteSchema(database)
    const effects = createSqlitePullRequestEffects(database)
    const input = {
      streamId: "stream_1",
      runId: "master_stream_1",
      idempotencyKey: "stream_1:pr",
      repository: "claxedo/app",
      head: "workgraph/v2",
      base: "dev",
      title: "Release WorkGraph V2",
      draft: true,
      publicRepository: true,
    }

    const first = await effects.claim(context(), input)
    expect(first).toMatchObject({ state: "claimed", outboxId: expect.any(String), leaseId: expect.any(String) })
    await expect(effects.claim(context(), input)).resolves.toEqual({ state: "busy" })
    if (first.state !== "claimed") throw new Error("Expected claimed effect")
    database.prepare("UPDATE wg_v2_outbox SET claim_expires_at = 0 WHERE id = ?").run(first.outboxId)
    const reclaimed = await effects.claim(context(), input)
    expect(reclaimed).toMatchObject({ state: "claimed", outboxId: first.outboxId })
    if (reclaimed.state !== "claimed") throw new Error("Expected reclaimed effect")
    const result = {
      type: "open_pull_request" as const,
      pullRequestId: "42",
      url: "https://github.com/claxedo/app/pull/42",
      draft: true,
      durableEffectReceiptId: "receipt_pr_42",
      evidenceId: "evidence_pr_42",
    }
    await expect(effects.complete(context(), { ...reclaimed, result })).resolves.toEqual(result)
    await expect(effects.claim(context(), input)).resolves.toEqual({ state: "completed", result })
    expect(database.prepare(`
      SELECT effect_type, status, attempt_count, claimed_by, claim_expires_at FROM wg_v2_outbox
    `).get()).toEqual({
      effect_type: "open_pull_request",
      status: "completed",
      attempt_count: 2,
      claimed_by: null,
      claim_expires_at: null,
    })
  })
})

function context(): WorkGraphContext {
  return {
    organizationId: "organization" as never,
    ownerUserId: "owner" as never,
    actor: { type: "agent", id: "ses_master_stream_1" as never },
    requestId: "request_1" as never,
    access: { mode: "owner" },
  }
}
