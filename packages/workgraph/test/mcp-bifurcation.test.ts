import { describe, expect, test } from "vitest"
import Database from "better-sqlite3"
import { initializeDb } from "../src/app"
import { getToolDefinitions, handleToolCall } from "../src/mcp/tools"
import { openSqliteEventStore } from "../src/substrate/event-store-sqlite"
import { getWorkGraph, initWorkGraph, resetWorkGraph } from "../src/model/registry"
import { openSqlitePlannerStore } from "../src/sdk/planner"

function setup() {
  const db = new Database(":memory:")
  initializeDb(db)
  const runId = `run_${crypto.randomUUID()}`
  const now = new Date().toISOString()
  db.prepare("INSERT INTO runs_current (run_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(runId, "goal", "planning", now, now)
  const eventStore = openSqliteEventStore(db)
  return {
    db,
    runId,
    eventStore,
    ctx: {
      plannerStore: openSqlitePlannerStore(db),
      eventStore,
      runId,
    },
  }
}

describe("MCP role bifurcation", () => {
  test("filters tool definitions by role", () => {
    expect(getToolDefinitions("agent").map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "get_graph",
      "read_loadout",
      "write_scratchpad",
    ]))
    expect(getToolDefinitions("agent").map((tool) => tool.name).filter((name) => name.startsWith("propose_"))).toEqual([])
    expect(getToolDefinitions("agent").map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
      "create_decision",
      "answer_decision",
      "submit_review_batch",
    ]))
    expect(getToolDefinitions("captain").map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "answer_decision",
      "create_decision",
      "get_graph",
      "list_decisions",
      "propose_loadout_update",
      "propose_merge_nodes",
      "propose_reparent_node",
      "propose_split_node",
      "propose_sync_source",
      "propose_create_node",
      "submit_review_batch",
    ]))
    expect(getToolDefinitions("captain").map((tool) => tool.name)).not.toContain("write_scratchpad")
  })

  test("working agents cannot call Captain mutators", async () => {
    const { db, ctx } = setup()

    const result = await handleToolCall(ctx, "propose_create_node", {
      title: "Task",
      kind: "research",
      role: "developer",
      prompt: "Do it",
    }, "agent")

    expect(result).toEqual({
      error: "Tool 'propose_create_node' is not available for role 'agent'",
      status: 403,
      code: "tool_not_in_role_surface",
      tool: "propose_create_node",
      calling_role: "agent",
      required_role: "captain",
      hint:
        "Working agents narrate via `write_scratchpad`; the Captain mutates the graph. " +
        "If you want to propose a change, write your reasoning into the scratchpad and the Captain will pick it up.",
    })
    expect(db.prepare("SELECT COUNT(*) AS count FROM nodes_current").get()).toEqual({ count: 0 })
    db.close()
  })

  test("captains can propose node creation and emit an audit event before mutation", async () => {
    const { db, ctx, eventStore, runId } = setup()

    const result = await handleToolCall(ctx, "propose_create_node", {
      title: "Task",
      kind: "research",
      role: "developer",
      prompt: "Do it",
    }, "captain")

    expect(result).toEqual(expect.objectContaining({ node_id: expect.any(String), runtime_type: "task" }))
    expect(db.prepare("SELECT title FROM nodes_current").all()).toEqual([{ title: "Task" }])
    expect((await eventStore.getEvents(runId)).map((event) => event.type)).toEqual(["captain_proposed", "node_created"])
    db.close()
  })

  test("working agents can write scratchpads", async () => {
    const { db, ctx } = setup()
    db.prepare("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count, node_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("node_1", ctx.runId, "developer", "research", "Task", "active", 0, "task")

    const result = await handleToolCall({ ...ctx, nodeId: "node_1" }, "write_scratchpad", {
      subject_type: "run_node",
      subject_id: "node_1",
      content: "findings",
    }, "agent")

    expect(result).toEqual({ scratchpad_id: expect.any(String) })
    expect(db.prepare("SELECT content FROM scratchpad_entries").all()).toEqual([{ content: "findings" }])
    db.close()
  })

  test("captain remove-edge proposals on in-flight work create decisions without mutating edges", async () => {
    const { db, ctx, eventStore, runId } = setup()
    db.prepare("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count, node_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("source", runId, "developer", "research", "Source", "active", 0, "task")
    db.prepare("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count, node_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("target", runId, "developer", "research", "Target", "pending", 0, "task")
    db.prepare("INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)")
      .run("edge_1", runId, "source", "target", "depends_on")

    const result = await handleToolCall(ctx, "propose_remove_edge", {
      source_id: "source",
      target_id: "target",
    }, "captain")

    expect(result).toEqual({ decision_id: expect.stringMatching(/^decision_/) })
    expect(db.prepare("SELECT source_id, target_id FROM dependency_edges_current").all()).toEqual([
      { source_id: "source", target_id: "target" },
    ])
    const events = await eventStore.getEvents(runId)
    expect(events.map((event) => event.type)).toEqual(["captain_proposed", "decision_created"])
    expect(JSON.parse(events[0].payload_json)).toEqual(expect.objectContaining({
      intent_kind: "remove_edge",
      outcome: "action",
    }))
    expect(JSON.parse(events[1].payload_json)).toEqual(expect.objectContaining({
      kind: "action",
      intent_kind: "remove_edge",
      status: "open",
    }))
    db.close()
  })

  test("working agents can read resolved loadout", async () => {
    const { db, ctx } = setup()

    const result = await handleToolCall(ctx, "read_loadout", {
      subject: { type: "system" },
      kind: "triage_mode",
    }, "agent")

    expect(result).toEqual(expect.objectContaining({
      source: "default",
      name: "normal",
      kind: "triage_mode",
    }))
    db.close()
  })

  test("captain create proposals for agent-run scratchpads mutate WorkGraph through policy", async () => {
    resetWorkGraph()
    initWorkGraph()
    const { db, eventStore } = setup()
    const intake = getWorkGraph().captureIntakeItem({
      bodyMd: "Please split the work into implementation tasks.",
    })
    getWorkGraph().writeScratchpad({
      workItemId: intake.id,
      agentRunId: "agent_run_triage",
      kind: "triage",
      content: "Create an implementation task.",
      actor: "triage",
    })

    try {
      const result = await handleToolCall({
        plannerStore: openSqlitePlannerStore(db),
        eventStore,
        runId: "agent_run_triage",
      }, "propose_create_node", {
        title: "Implement async intake",
        kind: "implementation",
        role: "developer",
        prompt: "Build the async intake path.",
      }, "captain")

      expect(result).toEqual(expect.objectContaining({
        outcome: "applied",
        item_id: expect.any(String),
      }))
      expect(getWorkGraph().getAll().map((item) => item.title)).toContain("Implement async intake")
      expect(db.prepare("SELECT title FROM nodes_current").all()).toEqual([])
      expect(getWorkGraph().getEvents().map((event) => event.type)).toContain("captain_proposed")
    } finally {
      db.close()
      resetWorkGraph()
    }
  })

  test("captain create proposals for ambiguous agent-run scratchpads create WorkGraph decisions", async () => {
    resetWorkGraph()
    initWorkGraph()
    const { db, eventStore } = setup()
    const intake = getWorkGraph().captureIntakeItem({
      bodyMd: "Please split the work, but parent scope is ambiguous.",
    })
    getWorkGraph().writeScratchpad({
      workItemId: intake.id,
      agentRunId: "agent_run_ambiguous",
      kind: "triage",
      content: "Create an implementation task, but parent scope needs human confirmation.",
      actor: "triage",
    })

    try {
      const result = await handleToolCall({
        plannerStore: openSqlitePlannerStore(db),
        eventStore,
        runId: "agent_run_ambiguous",
      }, "propose_create_node", {
        title: "Implement ambiguous scope",
        kind: "implementation",
        role: "developer",
        prompt: "Build the scoped implementation after parent confirmation.",
        confidence: 0.42,
      }, "captain")

      expect(result).toEqual(expect.objectContaining({
        outcome: "decision",
        decision_id: expect.any(String),
      }))
      expect(getWorkGraph().getAll().map((item) => item.title)).not.toContain("Implement ambiguous scope")
      expect(Object.values(getWorkGraph().getState().decisions)).toEqual([
        expect.objectContaining({
          kind: "clarification",
          intentKind: "add_node",
          subjectType: "intake_item",
          subjectId: intake.id,
          confidence: 0.42,
        }),
      ])
      expect(getWorkGraph().getEvents().map((event) => event.type).slice(-2)).toEqual([
        "captain_proposed",
        "decision_created",
      ])
    } finally {
      db.close()
      resetWorkGraph()
    }
  })

  test("captain reparent proposals for agent-run scratchpads mutate WorkGraph through policy", async () => {
    resetWorkGraph()
    initWorkGraph()
    const { db, eventStore } = setup()
    const parent = getWorkGraph().create({ title: "Parent" })
    const child = getWorkGraph().create({ title: "Child" })
    const intake = getWorkGraph().captureIntakeItem({
      bodyMd: "Move the child under the parent.",
    })
    getWorkGraph().writeScratchpad({
      subjectType: "intake_item",
      subjectId: intake.id,
      workItemId: intake.id,
      agentRunId: "agent_run_reparent",
      kind: "triage",
      content: "Reparent Child under Parent.",
      actor: "triage",
    })

    try {
      const result = await handleToolCall({
        plannerStore: openSqlitePlannerStore(db),
        eventStore,
        runId: "agent_run_reparent",
      }, "propose_reparent_node", {
        node_id: child.id,
        parent_id: parent.id,
      }, "captain")

      expect(result).toEqual(expect.objectContaining({
        outcome: "applied",
        item_id: child.id,
      }))
      expect(getWorkGraph().get(child.id)?.parentId).toBe(parent.id)
      expect(getWorkGraph().getEvents().map((event) => event.type)).toContain("captain_proposed")
    } finally {
      db.close()
      resetWorkGraph()
    }
  })

  test("captain split proposals create child tasks instead of silently no-oping", async () => {
    resetWorkGraph()
    initWorkGraph()
    const { db, eventStore } = setup()
    const source = getWorkGraph().create({ title: "Large task" })
    getWorkGraph().writeScratchpad({
      subjectType: "run_node",
      subjectId: source.id,
      workItemId: source.id,
      agentRunId: "agent_run_split",
      kind: "triage",
      content: "Split the task into implementation and tests.",
      actor: "triage",
    })

    try {
      const result = await handleToolCall({
        plannerStore: openSqlitePlannerStore(db),
        eventStore,
        runId: "agent_run_split",
      }, "propose_split_node", {
        node_id: source.id,
        new_nodes: [
          { title: "Implement feature", description: "Build the feature." },
          { title: "Verify feature", description: "Run targeted tests." },
        ],
      }, "captain")

      expect(result).toEqual(expect.objectContaining({
        outcome: "applied",
        item_id: source.id,
      }))
      expect(getWorkGraph().getChildren(source.id).map((item) => item.title)).toEqual([
        "Implement feature",
        "Verify feature",
      ])
    } finally {
      db.close()
      resetWorkGraph()
    }
  })

  test("captain decision tools create and resolve reviewable decisions", async () => {
    resetWorkGraph()
    initWorkGraph()
    const { db, ctx } = setup()
    const item = getWorkGraph().create({ title: "Task to finish" })

    try {
      const created = await handleToolCall(ctx, "create_decision", {
        kind: "clarification",
        intent_kind: "update_status",
        subject_type: "work_item",
        subject_id: item.id,
        prompt_md: "Mark this task done?",
        recommended_intent_payload: {
          intentKind: "update_status",
          subjectType: "work_item",
          subjectId: item.id,
          confidence: 0.9,
          evidenceMd: "Human confirmed completion.",
          nodeId: item.id,
          status: "done",
        },
      }, "captain")

      expect(created).toEqual({ decision_id: expect.any(String) })
      const answered = await handleToolCall(ctx, "answer_decision", {
        decision_id: created.decision_id,
        action: "accept",
      }, "captain")

      expect(answered).toEqual(expect.objectContaining({
        id: created.decision_id,
        status: "applied",
      }))
      expect(getWorkGraph().get(item.id)?.status).toBe("done")
    } finally {
      db.close()
      resetWorkGraph()
    }
  })
})
