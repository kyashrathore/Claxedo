import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { createSqliteWorkGraphService } from "../src/adapters/sqlite/store"
import { EvidenceDtoSchema, EvidencePageSchema, type EvidenceID, type OutcomeID, type StreamID, type WorkGraphContext, type WorkItemID } from "../src/contracts"

const databases: BetterSqlite3.Database[] = []

afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("SQLite targeted Evidence queries", () => {
  it("reads exact owner Evidence and paginates one subject by recordedAt then id", async () => {
    const database = new BetterSqlite3(":memory:")
    databases.push(database)
    let nextId = 0
    const service = createSqliteWorkGraphService({
      database,
      clock: { now: () => 1_000 },
      ids: { next: (kind) => `${kind}_${String(++nextId).padStart(3, "0")}` },
    }).service
    const streamId = resultId(await execute(service, owner("owner_a"), "stream", { type: "create_stream", title: "Private" }), "streamId") as StreamID
    const outcomeId = resultId(await execute(service, owner("owner_a"), "outcome", {
      type: "create_outcome",
      streamId,
      title: "Shipped",
      successCriteria: ["Healthy"],
    }), "outcomeId") as OutcomeID
    const workItemId = resultId(await execute(service, owner("owner_a"), "item", {
      type: "create_work_item",
      streamId,
      title: "Ship",
      dependencyIds: [],
      completionContract: {
        version: 1,
        mode: "all",
        requirements: [{ id: "verified", kind: "verification", description: "Verified", instructions: "Inspect" }],
      },
    }), "workItemId") as WorkItemID
    for (const index of [1, 2, 3]) {
      await execute(service, owner("owner_a"), `evidence_${index}`, {
        type: "record_evidence",
        subject: { type: "work_item", workItemId },
        requirementId: "verified",
        evidence: { kind: "finding", summary: `Finding ${index}`, sourceRef: `session:${index}` },
      })
    }
    await execute(service, owner("owner_a"), "evidence_stream", {
      type: "record_evidence",
      subject: { type: "stream", streamId },
      evidence: { kind: "finding", summary: "Stream finding" },
    })
    await execute(service, owner("owner_a"), "evidence_outcome", {
      type: "record_evidence",
      subject: { type: "outcome", outcomeId },
      evidence: { kind: "finding", summary: "Outcome finding" },
    })
    const orderedIds = (database.prepare(`
      SELECT id FROM wg_v2_evidence WHERE owner_user_id = 'owner_a' AND subject_id = ? ORDER BY created_at, id
    `).all(workItemId) as Array<{ id: EvidenceID }>).map((row) => row.id)
    const firstEvidenceId = orderedIds[0]
    if (!firstEvidenceId) throw new Error("Expected recorded Evidence")

    const first = EvidencePageSchema.parse(await service.query(owner("owner_a"), "evidence", "list", {
      subject: { type: "work_item", workItemId },
      limit: 2,
    }))
    expect(first.evidence.map((evidence) => evidence.id)).toEqual(orderedIds.slice(0, 2))
    expect(first).toMatchObject({ hasMore: true, nextCursor: expect.stringMatching(/^wgep1:/) })

    const second = EvidencePageSchema.parse(await service.query(owner("owner_a"), "evidence", "list", {
      subject: { type: "work_item", workItemId },
      after: first.nextCursor,
      limit: 2,
    }))
    expect(second.evidence.map((evidence) => evidence.id)).toEqual(orderedIds.slice(2))
    expect(second).toMatchObject({ hasMore: false })
    expect(second.nextCursor).toBeUndefined()
    expect(await service.query(owner("owner_a"), "evidence", "list", {
      subject: { type: "stream", streamId },
      limit: 10,
    })).toMatchObject({ evidence: [{ subject: { type: "stream", streamId }, summary: "Stream finding" }], hasMore: false })
    expect(await service.query(owner("owner_a"), "evidence", "list", {
      subject: { type: "outcome", outcomeId },
      limit: 10,
    })).toMatchObject({ evidence: [{ subject: { type: "outcome", outcomeId }, summary: "Outcome finding" }], hasMore: false })

    expect(EvidenceDtoSchema.parse(await service.query(owner("owner_a"), "evidence", "read", {
      evidenceId: firstEvidenceId,
    }))).toMatchObject({
      id: firstEvidenceId,
      subject: { type: "work_item", workItemId },
      requirementId: "verified",
      recordedAt: 1_000,
      recordedBy: { type: "user", id: "owner_a" },
    })
    expect(await service.query(owner("owner_b"), "evidence", "read", { evidenceId: firstEvidenceId })).toBeUndefined()
    await expect(service.query(owner("owner_b"), "evidence", "list", {
      subject: { type: "work_item", workItemId },
      after: first.nextCursor,
      limit: 2,
    })).rejects.toMatchObject({ name: "EvidencePageCursorError", reason: "owner_mismatch" })
    await expect(service.query(owner("owner_a"), "evidence", "list", {
      subject: { type: "stream", streamId },
      after: first.nextCursor,
      limit: 2,
    })).rejects.toMatchObject({ name: "EvidencePageCursorError", reason: "subject_mismatch" })
  })
})

function owner(ownerUserId: string): WorkGraphContext {
  return {
    organizationId: "organization" as never,
    ownerUserId: ownerUserId as never,
    actor: { type: "user", id: ownerUserId as never },
    requestId: `request_${ownerUserId}` as never,
    access: { mode: "owner" },
  }
}

async function execute(
  service: ReturnType<typeof createSqliteWorkGraphService>["service"],
  context: WorkGraphContext,
  operationId: string,
  command: Record<string, unknown>,
) {
  return service.execute(context, { operationId, command: { version: 1, ...command } } as never)
}

function resultId(result: Awaited<ReturnType<typeof execute>>, key: string) {
  if (!result.ok) throw new Error(result.error.message)
  if (!result.value || typeof result.value !== "object" || Array.isArray(result.value)) throw new Error(`Missing ${key}`)
  const value = result.value[key]
  if (typeof value !== "string") throw new Error(`Missing ${key}`)
  return value
}
