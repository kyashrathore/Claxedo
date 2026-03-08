import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { EventEnvelope } from "@opencode-ai/orchestrator-events";
import { appendEvent, getEvents, replayEvents } from "../../src/services/event-store";
import { rootReducer, initialRootState, type RootState } from "../../src/reducers/index";

describe("Event Replay Integration", () => {
  let db: ReturnType<typeof drizzle>;
  let sqlite: Database;
  let counter: number;

  beforeEach(() => {
    counter = 1;
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);

    sqlite.run(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_seq INTEGER NOT NULL,
        logical_ts INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        op_id TEXT NOT NULL UNIQUE,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  });

  function makeEvent(
    overrides: Partial<EventEnvelope> & Pick<EventEnvelope, "type" | "payload_json">
  ): EventEnvelope {
    const seq = counter++;
    return {
      id: `evt_${seq}`,
      run_id: "run_1",
      stream_id: "run_1",
      stream_seq: seq,
      logical_ts: seq,
      schema_version: 1,
      actor_type: "system",
      actor_id: "test",
      op_id: `op_${seq}`,
      prev_hash: "00000000",
      hash: `hash_${seq}`,
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  function buildMixedEvents(): EventEnvelope[] {
    return [
      // 1. run_created
      makeEvent({
        type: "run_created",
        payload_json: JSON.stringify({ goal: "Build full-stack auth system" }),
      }),
      // 2. team_created: frontend
      makeEvent({
        type: "team_created",
        payload_json: JSON.stringify({ team_id: "team_fe", name: "Frontend" }),
      }),
      // 3. team_created: backend
      makeEvent({
        type: "team_created",
        payload_json: JSON.stringify({ team_id: "team_be", name: "Backend" }),
      }),
      // 4. team_member_added to frontend
      makeEvent({
        type: "team_member_added",
        payload_json: JSON.stringify({ team_id: "team_fe", agent_id: "agent_ui" }),
      }),
      // 5. team_member_added to backend
      makeEvent({
        type: "team_member_added",
        payload_json: JSON.stringify({ team_id: "team_be", agent_id: "agent_api" }),
      }),
      // 6. node_created: lead task
      makeEvent({
        type: "node_created",
        payload_json: JSON.stringify({ node_id: "node_lead", kind: "lead_task", team_id: "team_fe" }),
      }),
      // 7. node_created: team task
      makeEvent({
        type: "node_created",
        payload_json: JSON.stringify({ node_id: "node_team", kind: "team_task", team_id: "team_be" }),
      }),
      // 8. node_status_changed
      makeEvent({
        type: "node_status_changed",
        payload_json: JSON.stringify({ node_id: "node_lead", status: "active" }),
      }),
      // 9. edge_added
      makeEvent({
        type: "edge_added",
        payload_json: JSON.stringify({ id: "edge_1", source_id: "node_lead", target_id: "node_team", type: "hard" }),
      }),
      // 10. message_posted
      makeEvent({
        type: "message_posted",
        payload_json: JSON.stringify({
          id: "msg_1",
          team_id: "team_fe",
          sender_id: "agent_ui",
          content: "Starting UI work",
          message_type: "propose",
        }),
      }),
      // 11. handoff_requested
      makeEvent({
        type: "handoff_requested",
        payload_json: JSON.stringify({
          id: "handoff_1",
          from_team_id: "team_fe",
          to_team_id: "team_be",
        }),
      }),
      // 12. artifact_created
      makeEvent({
        type: "artifact_created",
        payload_json: JSON.stringify({
          id: "artifact_1",
          node_id: "node_lead",
          content: "Login component code",
          version: 1,
        }),
      }),
      // 13. decision_proposed
      makeEvent({
        type: "decision_proposed",
        payload_json: JSON.stringify({
          id: "decision_1",
          proposal: "Use JWT for authentication",
        }),
      }),
      // 14. run_planned
      makeEvent({
        type: "run_planned",
        payload_json: JSON.stringify({ plan_id: "plan_1" }),
      }),
      // 15. lead_plan_created
      makeEvent({
        type: "lead_plan_created",
        payload_json: JSON.stringify({ plan_id: "lead_plan_1" }),
      }),
      // 16. question_scoped
      makeEvent({
        type: "question_scoped",
        payload_json: JSON.stringify({ question: "What auth library to use?" }),
      }),
      // 17. route_scored
      makeEvent({
        type: "route_scored",
        payload_json: JSON.stringify({ route_id: "route_1", team_id: "team_be", confidence: 0.85 }),
      }),
      // 18. handoff_accepted
      makeEvent({
        type: "handoff_accepted",
        payload_json: JSON.stringify({ id: "handoff_1" }),
      }),
      // 19. decision_challenged
      makeEvent({
        type: "decision_challenged",
        payload_json: JSON.stringify({ id: "decision_1", challenger_id: "agent_api" }),
      }),
      // 20. lead_gap_detected
      makeEvent({
        type: "lead_gap_detected",
        payload_json: JSON.stringify({ plan_id: "lead_plan_1", gap: "Missing test coverage" }),
      }),
    ];
  }

  it("should replay 20 mixed events and verify every projection slice", async () => {
    const events = buildMixedEvents();

    // Insert all events into the DB
    for (const evt of events) {
      await appendEvent(db, evt);
    }

    // Replay through rootReducer
    const state = await replayEvents(db, "run_1", rootReducer, { ...initialRootState });

    // -- Runs --
    expect(state.run.runs["run_1"]).toBeDefined();
    expect(state.run.runs["run_1"].goal).toBe("Build full-stack auth system");
    expect(state.run.runs["run_1"].status).toBe("planned"); // run_planned changes status to planned

    // -- Teams --
    expect(state.team.teams["team_fe"]).toBeDefined();
    expect(state.team.teams["team_fe"].name).toBe("Frontend");
    expect(state.team.teams["team_fe"].status).toBe("active");
    expect(state.team.teams["team_fe"].members).toEqual(["agent_ui"]);

    expect(state.team.teams["team_be"]).toBeDefined();
    expect(state.team.teams["team_be"].name).toBe("Backend");
    expect(state.team.teams["team_be"].members).toEqual(["agent_api"]);

    // -- Nodes --
    expect(state.node.nodes["node_lead"]).toBeDefined();
    expect(state.node.nodes["node_lead"].kind).toBe("lead_task");
    expect(state.node.nodes["node_lead"].status).toBe("active");
    expect(state.node.nodes["node_lead"].team_id).toBe("team_fe");

    expect(state.node.nodes["node_team"]).toBeDefined();
    expect(state.node.nodes["node_team"].kind).toBe("team_task");
    expect(state.node.nodes["node_team"].status).toBe("pending");

    // -- Edges --
    expect(state.edge.edges).toHaveLength(1);
    expect(state.edge.edges[0].id).toBe("edge_1");
    expect(state.edge.edges[0].source_id).toBe("node_lead");
    expect(state.edge.edges[0].target_id).toBe("node_team");
    expect(state.edge.edges[0].type).toBe("hard");

    // -- Messages --
    expect(state.message.messages).toHaveLength(1);
    expect(state.message.messages[0].id).toBe("msg_1");
    expect(state.message.messages[0].team_id).toBe("team_fe");
    expect(state.message.messages[0].content).toBe("Starting UI work");
    expect(state.message.messages[0].type).toBe("propose");

    // -- Handoffs --
    expect(state.handoff.handoffs["handoff_1"]).toBeDefined();
    expect(state.handoff.handoffs["handoff_1"].from_team).toBe("team_fe");
    expect(state.handoff.handoffs["handoff_1"].to_team).toBe("team_be");
    expect(state.handoff.handoffs["handoff_1"].status).toBe("accepted");

    // -- Artifacts --
    expect(state.artifact.artifacts["artifact_1"]).toBeDefined();
    expect(state.artifact.artifacts["artifact_1"].node_id).toBe("node_lead");
    expect(state.artifact.artifacts["artifact_1"].content).toBe("Login component code");
    expect(state.artifact.artifacts["artifact_1"].version).toBe(1);

    // -- Decisions --
    expect(state.decision.decisions["decision_1"]).toBeDefined();
    expect(state.decision.decisions["decision_1"].proposal).toBe("Use JWT for authentication");
    expect(state.decision.decisions["decision_1"].status).toBe("challenged");
    expect(state.decision.decisions["decision_1"].challenger_id).toBe("agent_api");

    // -- Planning --
    expect(state.planning.plans["run_1"]).toBeDefined();
    expect(state.planning.plans["run_1"].questions).toContain("What auth library to use?");
    expect(state.planning.plans["run_1"].routes["route_1"]).toBeDefined();
    expect(state.planning.plans["run_1"].routes["route_1"].team_id).toBe("team_be");
    expect(state.planning.plans["run_1"].routes["route_1"].confidence).toBe(0.85);

    // -- Lead Plans --
    expect(state.lead.leadPlans["lead_plan_1"]).toBeDefined();
    expect(state.lead.leadPlans["lead_plan_1"].gaps).toContain("Missing test coverage");
    expect(state.lead.leadPlans["lead_plan_1"].reroutes).toEqual([]);
  });

  it("should produce deterministic state when replayed twice", async () => {
    const events = buildMixedEvents();

    for (const evt of events) {
      await appendEvent(db, evt);
    }

    const state1 = await replayEvents(db, "run_1", rootReducer, { ...initialRootState });
    const state2 = await replayEvents(db, "run_1", rootReducer, { ...initialRootState });

    expect(JSON.stringify(state1)).toBe(JSON.stringify(state2));
  });

  it("should handle incremental replay using sinceSeq", async () => {
    const events = buildMixedEvents();
    for (const evt of events) {
      await appendEvent(db, evt);
    }

    // Replay first 10 events
    const first10 = await getEvents(db, "run_1");
    let state: RootState = { ...initialRootState };
    for (let i = 0; i < 10; i++) {
      state = rootReducer(state, first10[i]);
    }

    // At this point, run should be active (not yet planned)
    expect(state.run.runs["run_1"].status).toBe("active");
    expect(state.edge.edges).toHaveLength(1);
    expect(state.message.messages).toHaveLength(1);

    // Now replay remaining events
    const remaining = await getEvents(db, "run_1", 10);
    for (const evt of remaining) {
      state = rootReducer(state, evt);
    }

    // Should match full replay
    expect(state.run.runs["run_1"].status).toBe("planned");
    expect(state.handoff.handoffs["handoff_1"].status).toBe("accepted");
    expect(state.decision.decisions["decision_1"].status).toBe("challenged");
  });

  it("should maintain correct counts across all projection slices", async () => {
    const events = buildMixedEvents();
    for (const evt of events) {
      await appendEvent(db, evt);
    }

    const state = await replayEvents(db, "run_1", rootReducer, { ...initialRootState });

    expect(Object.keys(state.run.runs)).toHaveLength(1);
    expect(Object.keys(state.team.teams)).toHaveLength(2);
    expect(Object.keys(state.node.nodes)).toHaveLength(2);
    expect(state.edge.edges).toHaveLength(1);
    expect(state.message.messages).toHaveLength(1);
    expect(Object.keys(state.handoff.handoffs)).toHaveLength(1);
    expect(Object.keys(state.artifact.artifacts)).toHaveLength(1);
    expect(Object.keys(state.decision.decisions)).toHaveLength(1);
    expect(Object.keys(state.planning.plans)).toHaveLength(1);
    expect(Object.keys(state.lead.leadPlans)).toHaveLength(1);
  });

  it("should ignore unknown event types without corrupting state", async () => {
    const events = [
      makeEvent({
        type: "run_created",
        payload_json: JSON.stringify({ goal: "Test" }),
      }),
      makeEvent({
        type: "completely_unknown_event_type" as any,
        payload_json: JSON.stringify({ foo: "bar" }),
      }),
    ];

    for (const evt of events) {
      await appendEvent(db, evt);
    }

    const state = await replayEvents(db, "run_1", rootReducer, { ...initialRootState });
    expect(state.run.runs["run_1"]).toBeDefined();
    expect(state.run.runs["run_1"].goal).toBe("Test");
    // All other slices should remain at initial state
    expect(Object.keys(state.team.teams)).toHaveLength(0);
  });

  it("should handle second run_id independently", async () => {
    // Insert events for run_1
    await appendEvent(db, makeEvent({
      type: "run_created",
      run_id: "run_1",
      payload_json: JSON.stringify({ goal: "Goal 1" }),
    }));

    // Insert events for run_2
    await appendEvent(db, makeEvent({
      type: "run_created",
      run_id: "run_2",
      payload_json: JSON.stringify({ goal: "Goal 2" }),
    }));

    const state1 = await replayEvents(db, "run_1", rootReducer, { ...initialRootState });
    const state2 = await replayEvents(db, "run_2", rootReducer, { ...initialRootState });

    expect(state1.run.runs["run_1"].goal).toBe("Goal 1");
    expect(state1.run.runs["run_2"]).toBeUndefined();

    expect(state2.run.runs["run_2"].goal).toBe("Goal 2");
    expect(state2.run.runs["run_1"]).toBeUndefined();
  });

  it("should support dispatch_requested event marking plan as dispatched", async () => {
    const events = [
      makeEvent({
        type: "run_created",
        payload_json: JSON.stringify({ goal: "Test dispatch" }),
      }),
      makeEvent({
        type: "run_planned",
        payload_json: JSON.stringify({ plan_id: "plan_1" }),
      }),
      makeEvent({
        type: "dispatch_requested",
        payload_json: JSON.stringify({ dispatch_id: "d1" }),
      }),
    ];

    for (const evt of events) {
      await appendEvent(db, evt);
    }

    const state = await replayEvents(db, "run_1", rootReducer, { ...initialRootState });
    expect(state.planning.plans["run_1"].dispatched).toBe(true);
  });

  it("should accumulate lead reroutes", async () => {
    const events = [
      makeEvent({
        type: "lead_plan_created",
        payload_json: JSON.stringify({ plan_id: "lp_1" }),
      }),
      makeEvent({
        type: "lead_gap_detected",
        payload_json: JSON.stringify({ plan_id: "lp_1", gap: "Gap A" }),
      }),
      makeEvent({
        type: "lead_gap_detected",
        payload_json: JSON.stringify({ plan_id: "lp_1", gap: "Gap B" }),
      }),
      makeEvent({
        type: "lead_reroute_requested",
        payload_json: JSON.stringify({ plan_id: "lp_1", reroute: "Reroute to team_qa" }),
      }),
    ];

    for (const evt of events) {
      await appendEvent(db, evt);
    }

    const state = await replayEvents(db, "run_1", rootReducer, { ...initialRootState });
    expect(state.lead.leadPlans["lp_1"].gaps).toEqual(["Gap A", "Gap B"]);
    expect(state.lead.leadPlans["lp_1"].reroutes).toEqual(["Reroute to team_qa"]);
  });
});
