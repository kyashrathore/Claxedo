import { describe, expect, test } from "vitest"
import { WorkGraph } from "../src/model/workgraph"
import type { Intent } from "../src/model/policy-types"

function addNode(overrides: Partial<Intent> = {}): Intent {
  return {
    intentKind: "add_node",
    subjectType: "intake_item",
    subjectId: "intake_1",
    confidence: 0.93,
    evidenceMd: "The scratchpad clearly asks for one task.",
    title: "Fix flaky sync",
    description: "Investigate intermittent sync failures.",
    parentId: null,
    labels: ["sync"],
    ...overrides,
  } as Intent
}

describe("WorkGraph.propose", () => {
  test("applies high-confidence add_node intents and audits before mutation", () => {
    const wg = new WorkGraph(":memory:")

    const result = wg.propose(addNode())

    expect(result.outcome).toBe("applied")
    expect(result.firedRuleId).toBe("default-high-confidence-apply")
    expect(result.item?.title).toBe("Fix flaky sync")
    expect(wg.getAll().map((item) => item.title)).toContain("Fix flaky sync")
    expect(wg.getEvents().map((event) => event.type)).toEqual(["captain_proposed", "item_created"])

    const created = JSON.parse(wg.getEvents()[1].payload)
    expect(created.provenance).toEqual({
      actor: "captain",
      at: expect.any(String),
      confidence: 0.93,
      evidence: "The scratchpad clearly asks for one task.",
      sourceIntakeItemId: "intake_1",
      firedRuleId: "default-high-confidence-apply",
    })
    wg.close()
  })

  test("turns destructive delete_node intents into ActionDecisions without mutating the graph", () => {
    const wg = new WorkGraph(":memory:")
    const item = wg.create({ title: "Do not delete yet" })

    const result = wg.propose({
      intentKind: "delete_node",
      subjectType: "work_item",
      subjectId: item.id,
      confidence: 0.99,
      evidenceMd: "Captain thinks this is obsolete.",
      nodeId: item.id,
    })

    expect(result.outcome).toBe("decision")
    expect(result.decision?.kind).toBe("action")
    expect(result.decision?.intentKind).toBe("delete_node")
    expect(wg.get(item.id)?.deletedAt).toBeUndefined()
    expect(Object.values(wg.getState().decisions)).toEqual([expect.objectContaining({
      id: result.decision?.id,
      kind: "action",
      intentKind: "delete_node",
      status: "open",
    })])
    expect(wg.getEvents().map((event) => event.type).slice(-2)).toEqual(["captain_proposed", "decision_created"])
    wg.close()
  })

  test("existing direct create path still works", () => {
    const wg = new WorkGraph(":memory:")

    const item = wg.create({ title: "Planner path" })

    expect(item.title).toBe("Planner path")
    expect(wg.getEvents().map((event) => event.type)).toEqual(["item_created"])
    wg.close()
  })

  test("concurrent propose calls are sequenced as whole audit plus mutation pairs", async () => {
    const wg = new WorkGraph(":memory:")

    await Promise.all([
      Promise.resolve(wg.propose(addNode({ title: "A", subjectId: "intake_a" }))),
      Promise.resolve(wg.propose(addNode({ title: "B", subjectId: "intake_b" }))),
    ])

    expect(wg.getEvents().map((event) => event.type)).toEqual([
      "captain_proposed",
      "item_created",
      "captain_proposed",
      "item_created",
    ])
    expect(wg.getAll().map((item) => item.title).sort()).toEqual(["A", "B"])
    wg.close()
  })

  test("policy resolution failure emits captain_failed without partial graph mutation", () => {
    const wg = new WorkGraph(":memory:")

    expect(() => wg.propose(addNode(), { policyName: "missing" })).toThrow("AutoPolicy 'missing' not registered")

    expect(wg.getAll()).toEqual([])
    expect(wg.getEvents().map((event) => event.type)).toEqual(["captain_failed"])
    wg.close()
  })
})
