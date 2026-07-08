import { describe, expect, test } from "vitest"
import { WorkGraph } from "../src/model/workgraph"
import type { Intent } from "../src/model/policy-types"

function addNode(overrides: Partial<Intent> = {}): Intent {
  return {
    intentKind: "add_node",
    subjectType: "intake_item",
    subjectId: "intake_1",
    confidence: 0.31,
    evidenceMd: "Ambiguous scratchpad",
    title: "Fix flaky sync",
    description: "Investigate intermittent sync failures.",
    parentId: null,
    labels: ["sync"],
    ...overrides,
  } as Intent
}

describe("ReviewableDecision lifecycle", () => {
  test("accepts a clarification decision and applies its recommended intent", () => {
    const wg = new WorkGraph(":memory:")
    const proposed = wg.propose(addNode())
    if (proposed.outcome !== "decision") throw new Error("expected decision")

    const resolved = wg.acceptDecision(proposed.decision.id)

    expect(resolved.status).toBe("applied")
    expect(wg.getAll().map((item) => item.title)).toContain("Fix flaky sync")
    expect(wg.getEvents().map((event) => event.type).slice(-2)).toEqual(["item_created", "decision_resolved"])
    wg.close()
  })

  test("rejects a decision without mutating the graph", () => {
    const wg = new WorkGraph(":memory:")
    const proposed = wg.propose(addNode({ title: "Do not create" }))
    if (proposed.outcome !== "decision") throw new Error("expected decision")

    const resolved = wg.rejectDecision(proposed.decision.id)

    expect(resolved.status).toBe("rejected")
    expect(wg.getAll()).toEqual([])
    expect(JSON.parse(wg.getEvents().at(-1)!.payload)).toEqual(expect.objectContaining({
      id: proposed.decision.id,
      status: "rejected",
      outcome: "rejected",
    }))
    wg.close()
  })

  test("snoozes a decision and reopens it after the requested time", () => {
    const wg = new WorkGraph(":memory:")
    const proposed = wg.propose(addNode())
    if (proposed.outcome !== "decision") throw new Error("expected decision")

    wg.snoozeDecision(proposed.decision.id, "2026-05-02T01:00:00.000Z")
    expect(wg.getDecision(proposed.decision.id)?.status).toBe("snoozed")

    const reopened = wg.expireSnoozedDecisions("2026-05-02T01:00:01.000Z")

    expect(reopened.map((decision) => decision.id)).toEqual([proposed.decision.id])
    expect(wg.getDecision(proposed.decision.id)?.status).toBe("open")
    wg.close()
  })

  test("batch submission resolves all answers and leaves invalid batches open without partial changes", () => {
    const wg = new WorkGraph(":memory:")
    const first = wg.propose(addNode({ title: "First", subjectId: "intake_1" }))
    const second = wg.propose(addNode({ title: "Second", subjectId: "intake_2" }))
    if (first.outcome !== "decision" || second.outcome !== "decision") throw new Error("expected decisions")

    const submitted = wg.submitReviewBatch({
      submittedBy: "human",
      answers: [
        { decisionId: first.decision.id, action: "accept" },
        { decisionId: second.decision.id, action: "reject" },
      ],
    })

    expect(submitted.submittedAt).toEqual(expect.any(String))
    expect(wg.getDecision(first.decision.id)).toEqual(expect.objectContaining({ status: "applied", batchId: submitted.id }))
    expect(wg.getDecision(second.decision.id)).toEqual(expect.objectContaining({ status: "rejected", batchId: submitted.id }))

    expect(() => wg.submitReviewBatch({
      submittedBy: "human",
      answers: [
        { decisionId: first.decision.id, action: "reject" },
      ],
    })).toThrow("Decision is not open")
    expect(wg.getDecision(first.decision.id)?.status).toBe("applied")
    wg.close()
  })
})
