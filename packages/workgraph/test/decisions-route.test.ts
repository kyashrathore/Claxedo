import { describe, expect, test } from "vitest"
import Database from "better-sqlite3"
import { createApp, initializeDb } from "../src/app"
import { getWorkGraph, resetWorkGraph } from "../src/model/registry"
import type { Intent } from "../src/model/policy-types"

function json(body: unknown) {
  return {
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

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

describe("Decision routes", () => {
  test("lists, fetches, and submits decision answers", async () => {
    resetWorkGraph()
    const db = new Database(":memory:")
    initializeDb(db)
    const app = createApp(db)
    const proposed = getWorkGraph().propose(addNode())
    if (proposed.outcome !== "decision") throw new Error("expected decision")

    const list = await app.request("/decisions")
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({
      decisions: [expect.objectContaining({ id: proposed.decision.id, status: "open" })],
    })

    const filteredOut = await app.request("/decisions?subjectType=work_item&subjectId=other")
    expect(await filteredOut.json()).toEqual({ decisions: [] })

    const detail = await app.request(`/decisions/${proposed.decision.id}`)
    expect(detail.status).toBe(200)
    expect(await detail.json()).toEqual(expect.objectContaining({ id: proposed.decision.id }))

    const submitted = await app.request("/review-batches", json({
      submitted_by: "human",
      answers: [{ decision_id: proposed.decision.id, action: "accept" }],
    }))
    expect(submitted.status).toBe(201)
    expect(await submitted.json()).toEqual(expect.objectContaining({ submittedAt: expect.any(String) }))
    expect(getWorkGraph().getDecision(proposed.decision.id)?.status).toBe("applied")
    resetWorkGraph()
  })
})
