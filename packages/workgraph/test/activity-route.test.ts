import { afterEach, describe, expect, test, vi } from "vitest"
import Database from "better-sqlite3"
import { createApp, initializeDb } from "../src/app"
import { getWorkGraph, resetWorkGraph } from "../src/model/registry"

describe("Activity route", () => {
  afterEach(() => {
    vi.useRealTimers()
    resetWorkGraph()
  })

  test("GET /activity returns a hydrated intake timeline in chronological order", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-02T00:00:00.000Z"))
    resetWorkGraph()
    const db = new Database(":memory:")
    initializeDb(db)
    const app = createApp(db)
    const wg = getWorkGraph()

    const intake = wg.captureIntakeItem({
      kind: "manual",
      bodyMd: "Split async intake into tasks.",
      triageModeOverride: "normal",
    })
    vi.setSystemTime(new Date("2026-05-02T00:00:01.000Z"))
    wg.updateIntakeItem(intake.id, { status: "triaging" })
    vi.setSystemTime(new Date("2026-05-02T00:00:02.000Z"))
    const scratchpad = wg.writeScratchpad({
      workItemId: intake.id,
      agentRunId: "agent_run_1",
      kind: "triage",
      content: "Implement and QA async intake.",
      actor: "triage",
    })
    vi.setSystemTime(new Date("2026-05-02T00:00:03.000Z"))
    wg.propose({
      intentKind: "add_node",
      subjectType: "intake_item",
      subjectId: intake.id,
      confidence: 0.95,
      evidenceMd: "High confidence",
      title: "Implement async intake",
      description: "Build route and UI path.",
      labels: ["implementation"],
    })
    vi.setSystemTime(new Date("2026-05-02T00:00:04.000Z"))
    const proposed = wg.propose({
      intentKind: "add_node",
      subjectType: "intake_item",
      subjectId: intake.id,
      confidence: 0.2,
      evidenceMd: "Needs human placement.",
      title: "Clarify parent mission",
      description: "Ask where this belongs.",
      labels: ["clarification"],
    })
    if (proposed.outcome !== "decision") throw new Error("expected decision")
    vi.setSystemTime(new Date("2026-05-02T00:00:05.000Z"))
    wg.acceptDecision(proposed.decision.id)

    const res = await app.request(`/activity?subjectType=intake_item&subjectId=${intake.id}`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.entries.map((entry: { kind: string }) => entry.kind)).toEqual([
      "capture",
      "triage_started",
      "scratchpad_written",
      "captain_proposed",
      "captain_proposed",
      "decision_created",
      "decision_resolved",
    ])
    expect(body.entries.find((entry: { kind: string }) => entry.kind === "scratchpad_written")).toEqual(expect.objectContaining({
      link: { type: "scratchpad", id: scratchpad.id },
      payload: expect.objectContaining({ id: scratchpad.id }),
    }))
    expect(body.entries.find((entry: { kind: string }) => entry.kind === "decision_created")).toEqual(expect.objectContaining({
      link: { type: "decision", id: proposed.decision.id },
      title: expect.stringContaining("Clarify parent mission"),
    }))
  })

  test("GET /activity respects before and limit pagination", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-02T00:00:00.000Z"))
    resetWorkGraph()
    const db = new Database(":memory:")
    initializeDb(db)
    const app = createApp(db)
    const wg = getWorkGraph()
    const intake = wg.captureIntakeItem({ bodyMd: "Paginate this." })
    vi.setSystemTime(new Date("2026-05-02T00:00:01.000Z"))
    wg.updateIntakeItem(intake.id, { status: "triaging" })
    vi.setSystemTime(new Date("2026-05-02T00:00:02.000Z"))
    wg.writeScratchpad({
      workItemId: intake.id,
      agentRunId: "agent_run_1",
      kind: "triage",
      content: "Summary.",
    })

    const limited = await app.request(`/activity?subjectType=intake_item&subjectId=${intake.id}&limit=2`)
    expect((await limited.json()).entries.map((entry: { kind: string }) => entry.kind)).toEqual(["capture", "triage_started"])

    const before = encodeURIComponent("2026-05-02T00:00:02.000Z")
    const paged = await app.request(`/activity?subjectType=intake_item&subjectId=${intake.id}&before=${before}&limit=10`)
    expect((await paged.json()).entries.map((entry: { kind: string }) => entry.kind)).toEqual(["capture", "triage_started"])
  })
})
