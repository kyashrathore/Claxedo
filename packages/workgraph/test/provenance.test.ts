import { describe, expect, test } from "vitest"
import { WorkGraph } from "../src/model/workgraph"
import { freshnessOf, mostRecentProvenance } from "../src/model/provenance"

describe("provenance", () => {
  test("WorkGraph.create records default system provenance", () => {
    const wg = new WorkGraph(":memory:")
    const item = wg.create({ title: "A" })

    const event = wg.getEvents().find((event) => event.type === "item_created")
    expect(event).toBeDefined()
    expect(JSON.parse(event!.payload)).toEqual({
      item,
      provenance: {
        actor: "system",
        at: expect.any(String),
        confidence: null,
        evidence: null,
        sourceIntakeItemId: null,
        firedRuleId: null,
      },
    })
    wg.close()
  })

  test("captain updates can carry confidence, evidence, source intake item, and fired rule", () => {
    const wg = new WorkGraph(":memory:")
    const item = wg.create({ title: "A" })

    wg.update(item.id, { title: "A2" }, {
      provenance: {
        actor: "captain",
        confidence: 0.91,
        evidence: "Scratchpad says this title is clearer.",
        sourceIntakeItemId: "intake_1",
        firedRuleId: "default-high-confidence-apply",
      },
    })

    const payload = JSON.parse(wg.getEvents().find((event) => event.type === "item_updated")!.payload)
    expect(payload).toEqual(expect.objectContaining({
      id: item.id,
      changes: expect.objectContaining({ title: "A2" }),
      provenance: {
        actor: "captain",
        at: expect.any(String),
        confidence: 0.91,
        evidence: "Scratchpad says this title is clearer.",
        sourceIntakeItemId: "intake_1",
        firedRuleId: "default-high-confidence-apply",
      },
    }))
    wg.close()
  })

  test("edge mutations carry provenance", () => {
    const wg = new WorkGraph(":memory:")
    const a = wg.create({ title: "A" })
    const b = wg.create({ title: "B" })

    wg.addDep(a.id, b.id)

    expect(JSON.parse(wg.getEvents().find((event) => event.type === "edge_added")!.payload)).toEqual({
      edge: { source: a.id, target: b.id },
      provenance: {
        actor: "system",
        at: expect.any(String),
        confidence: null,
        evidence: null,
        sourceIntakeItemId: null,
        firedRuleId: null,
      },
    })
    wg.close()
  })

  test("freshness derives the most recent mutation provenance for an item", () => {
    const wg = new WorkGraph(":memory:")
    const item = wg.create({ title: "A" })
    wg.update(item.id, { title: "A2" }, {
      provenance: {
        actor: "captain",
        confidence: 0.67,
        evidence: "Low confidence rename.",
        sourceIntakeItemId: "intake_1",
        firedRuleId: "ask-ambiguous",
      },
    })

    expect(mostRecentProvenance(item.id, wg.getEvents())).toEqual({
      actor: "captain",
      at: expect.any(String),
      confidence: 0.67,
      evidence: "Low confidence rename.",
      sourceIntakeItemId: "intake_1",
      firedRuleId: "ask-ambiguous",
    })
    expect(freshnessOf(item.id, wg.getEvents())).toEqual({
      lastTouchedBy: "captain",
      lastTouchedAt: expect.any(String),
      lastTouchedConfidence: 0.67,
    })
    wg.close()
  })
})
