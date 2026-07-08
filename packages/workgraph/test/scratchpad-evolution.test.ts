import { describe, expect, test } from "vitest"
import Database from "better-sqlite3"
import { initializeDb } from "../src/app"
import { handleToolCall } from "../src/mcp/tools"
import { WorkGraph } from "../src/model/workgraph"
import { openSqliteEventStore } from "../src/substrate/event-store-sqlite"
import { getWorkGraph, initWorkGraph, resetWorkGraph } from "../src/model/registry"
import { openSqlitePlannerStore } from "../src/sdk/planner"

describe("Scratchpad evolution", () => {
  test("records executor scratchpads by agent run id and returns the latest entry for that run", () => {
    const wg = new WorkGraph(":memory:")
    const item = wg.create({ title: "Implement feature" })

    const entry = wg.writeScratchpad({
      workItemId: item.id,
      agentRunId: "agent_run_1",
      kind: "executor",
      content: "Implementation notes",
      actor: "agent",
    })

    expect(entry).toEqual(expect.objectContaining({
      subjectType: "run_node",
      subjectId: item.id,
      agentRunId: "agent_run_1",
      kind: "executor",
      needsReview: false,
    }))
    expect(wg.getLatestScratchpadByRun("agent_run_1")).toEqual(expect.objectContaining({
      id: entry.id,
      content: "Implementation notes",
      kind: "executor",
    }))
    expect(JSON.parse(wg.getEvents().at(-1)!.payload)).toEqual(expect.objectContaining({
      agentRunId: "agent_run_1",
      kind: "executor",
    }))
    wg.close()
  })

  test("rejects duplicate scratchpads for a completed agent run", () => {
    const wg = new WorkGraph(":memory:")
    const item = wg.create({ title: "Implement feature" })

    wg.writeScratchpad({
      workItemId: item.id,
      agentRunId: "agent_run_1",
      content: "First result",
    })

    expect(() => wg.writeScratchpad({
      workItemId: item.id,
      agentRunId: "agent_run_1",
      content: "Second result",
    })).toThrow("Scratchpad for agent run 'agent_run_1' already exists")
    expect(wg.getScratchpads(item.id).map((entry) => entry.content)).toEqual(["First result"])
    wg.close()
  })

  test("defaults legacy scratchpad writes to executor kind without requiring an agent run id", () => {
    const wg = new WorkGraph(":memory:")
    const item = wg.create({ title: "Legacy task" })

    const entry = wg.writeScratchpad({
      workItemId: item.id,
      content: "Legacy notes",
    })

    expect(entry.kind).toBe("executor")
    expect(entry.agentRunId).toBeUndefined()
    expect(wg.getLatestScratchpadByRun("missing")).toBeUndefined()
    wg.close()
  })

  test("planner write_scratchpad passes agent run id and kind through the tool event", async () => {
    const db = new Database(":memory:")
    initializeDb(db)
    const runId = `run_${crypto.randomUUID()}`
    const now = new Date().toISOString()
    db.prepare("INSERT INTO runs_current (run_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, "goal", "executing", now, now)
    db.prepare("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count, node_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("node_1", runId, "developer", "research", "Task", "active", 0, "task")
    const eventStore = openSqliteEventStore(db)

    const result = await handleToolCall({
      plannerStore: openSqlitePlannerStore(db),
      eventStore,
      runId,
      nodeId: "node_1",
    }, "write_scratchpad", {
      subject_type: "run_node",
      subject_id: "node_1",
      content: "Triage notes",
      agent_run_id: "agent_run_1",
      kind: "triage",
    }, "agent")

    expect(result).toEqual({
      scratchpad_id: expect.any(String),
      agent_run_id: "agent_run_1",
      kind: "triage",
    })
    expect(JSON.parse((await eventStore.getEvents(runId))[0].payload_json)).toEqual(expect.objectContaining({
      subject_type: "run_node",
      subject_id: "node_1",
      agent_run_id: "agent_run_1",
      kind: "triage",
    }))
    db.close()
  })

  test("triage write_scratchpad mirrors the agent run scratchpad into WorkGraph", async () => {
    resetWorkGraph()
    initWorkGraph()
    const db = new Database(":memory:")
    initializeDb(db)
    const intake = getWorkGraph().captureIntakeItem({
      bodyMd: "Please split the new issue into work.",
    })
    const runId = `run_${crypto.randomUUID()}`

    try {
      await handleToolCall({
        plannerStore: openSqlitePlannerStore(db),
        eventStore: openSqliteEventStore(db),
        runId,
        nodeId: intake.id,
      }, "write_scratchpad", {
        subject_type: "intake_item",
        subject_id: intake.id,
        content: "Create implementation and verification tasks.",
        agent_run_id: "agent_run_triage",
        kind: "triage",
      }, "agent")

      expect(getWorkGraph().getLatestScratchpadByRun("agent_run_triage")).toEqual(expect.objectContaining({
        subjectType: "intake_item",
        subjectId: intake.id,
        workItemId: intake.id,
        kind: "triage",
        content: "Create implementation and verification tasks.",
        actor: "triage",
      }))
    } finally {
      db.close()
      resetWorkGraph()
    }
  })
})
