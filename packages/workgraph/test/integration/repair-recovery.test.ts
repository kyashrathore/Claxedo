import { describe, it, expect, beforeEach } from "bun:test";
import type { EventEnvelope } from "@opencode-ai/orchestrator-events";
import { computeHash, verifyChain } from "../../src/services/hash-chain";
import { verify, rebuild, replay, reconcile } from "../../src/cli/repair";
import { rootReducer, initialRootState, type RootState } from "../../src/reducers/index";

describe("Repair & Recovery Integration", () => {
  let counter: number;

  beforeEach(() => {
    counter = 1;
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
      hash: "",
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  async function buildChainedEvents(): Promise<EventEnvelope[]> {
    const events: EventEnvelope[] = [];
    let prevHash = "00000000";

    const rawEvents = [
      makeEvent({
        type: "run_created",
        payload_json: JSON.stringify({ goal: "Build auth system" }),
      }),
      makeEvent({
        type: "team_created",
        payload_json: JSON.stringify({ team_id: "team_fe", name: "Frontend" }),
      }),
      makeEvent({
        type: "team_member_added",
        payload_json: JSON.stringify({ team_id: "team_fe", agent_id: "agent_ui" }),
      }),
      makeEvent({
        type: "node_created",
        payload_json: JSON.stringify({ node_id: "node_1", kind: "lead_task", team_id: "team_fe" }),
      }),
      makeEvent({
        type: "edge_added",
        payload_json: JSON.stringify({ id: "edge_1", source_id: "node_1", target_id: "node_2", type: "hard" }),
      }),
      makeEvent({
        type: "message_posted",
        payload_json: JSON.stringify({
          id: "msg_1",
          team_id: "team_fe",
          sender_id: "agent_ui",
          content: "Started work",
          message_type: "propose",
        }),
      }),
      makeEvent({
        type: "artifact_created",
        payload_json: JSON.stringify({ id: "art_1", node_id: "node_1", content: "code", version: 1 }),
      }),
      makeEvent({
        type: "handoff_requested",
        payload_json: JSON.stringify({ id: "h_1", from_team_id: "team_fe", to_team_id: "team_be" }),
      }),
      makeEvent({
        type: "decision_proposed",
        payload_json: JSON.stringify({ id: "d_1", proposal: "Use JWT" }),
      }),
      makeEvent({
        type: "run_planned",
        payload_json: JSON.stringify({ plan_id: "p_1" }),
      }),
    ];

    for (const evt of rawEvents) {
      evt.prev_hash = prevHash;
      evt.hash = await computeHash(evt, prevHash);
      prevHash = evt.hash;
      events.push(evt);
    }

    return events;
  }

  it("should verify a valid chain using repair verify()", async () => {
    const events = await buildChainedEvents();
    const result = await verify(events, verifyChain);

    expect(result.action).toBe("verify");
    expect(result.success).toBe(true);
    expect(result.details).toBe("Chain integrity verified");
    expect(result.eventsProcessed).toBe(10);
  });

  it("should detect corruption using repair verify()", async () => {
    const events = await buildChainedEvents();

    // Corrupt event at index 5
    events[5].payload_json = JSON.stringify({ tampered: true });

    const result = await verify(events, verifyChain);

    expect(result.success).toBe(false);
    expect(result.details).toContain("Chain broken at index 5");
  });

  it("should rebuild state from events using repair rebuild()", async () => {
    const events = await buildChainedEvents();
    const { result, state } = await rebuild(events, rootReducer, { ...initialRootState });

    expect(result.action).toBe("rebuild");
    expect(result.success).toBe(true);
    expect(result.eventsProcessed).toBe(10);
    expect(result.details).toBe("Rebuilt state from 10 events");

    // Verify rebuilt state
    expect(state.run.runs["run_1"]).toBeDefined();
    expect(state.run.runs["run_1"].goal).toBe("Build auth system");
    expect(state.run.runs["run_1"].status).toBe("planned");

    expect(state.team.teams["team_fe"]).toBeDefined();
    expect(state.team.teams["team_fe"].members).toContain("agent_ui");

    expect(state.node.nodes["node_1"]).toBeDefined();
    expect(state.node.nodes["node_1"].kind).toBe("lead_task");

    expect(state.edge.edges).toHaveLength(1);
    expect(state.message.messages).toHaveLength(1);
    expect(state.artifact.artifacts["art_1"]).toBeDefined();
    expect(state.handoff.handoffs["h_1"]).toBeDefined();
    expect(state.decision.decisions["d_1"]).toBeDefined();
    expect(state.planning.plans["run_1"]).toBeDefined();
  });

  it("should rebuild state consistently after corruption detection", async () => {
    const events = await buildChainedEvents();

    // First verify integrity
    const verifyResult = await verify(events, verifyChain);
    expect(verifyResult.success).toBe(true);

    // Build state from events
    const { state: state1 } = await rebuild(events, rootReducer, { ...initialRootState });

    // Now corrupt and detect — deep copy to avoid mutating the original events
    const corruptedEvents = events.map((e) => ({ ...e }));
    corruptedEvents[3].payload_json = JSON.stringify({ tampered: true });

    const corruptResult = await verify(corruptedEvents, verifyChain);
    expect(corruptResult.success).toBe(false);

    // Rebuild from original uncorrupted events should produce same state
    const { state: state2 } = await rebuild(events, rootReducer, { ...initialRootState });
    expect(JSON.stringify(state1)).toBe(JSON.stringify(state2));
  });

  it("should compare rebuilt vs target state using replay()", async () => {
    const events = await buildChainedEvents();

    // Build target state manually
    let targetState: RootState = { ...initialRootState };
    for (const evt of events) {
      targetState = rootReducer(targetState, evt);
    }

    // Use replay to compare
    const result = await replay(events, rootReducer, { ...initialRootState }, targetState);

    expect(result.action).toBe("replay");
    expect(result.success).toBe(true);
    expect(result.details).toBe("Replay matches target state");
    expect(result.eventsProcessed).toBe(10);
  });

  it("should detect divergence in replay when target state is wrong", async () => {
    const events = await buildChainedEvents();

    // Wrong target state
    const wrongTarget: RootState = {
      ...initialRootState,
      run: { runs: { run_1: { goal: "Wrong goal", status: "failed" } } },
    };

    const result = await replay(events, rootReducer, { ...initialRootState }, wrongTarget);

    expect(result.success).toBe(false);
    expect(result.details).toBe("Replay diverged from target state");
  });

  it("should reconcile local and remote event sets", async () => {
    const events = await buildChainedEvents();

    // Local has first 7 events
    const localEvents = events.slice(0, 7);
    // Remote has all 10
    const remoteEvents = events;

    const result = await reconcile(localEvents, remoteEvents);

    expect(result.action).toBe("reconcile");
    expect(result.success).toBe(true);
    expect(result.eventsProcessed).toBe(3); // 3 events missing locally
    expect(result.details).toBe("Found 3 missing events to apply");
  });

  it("should find no missing events when local has everything", async () => {
    const events = await buildChainedEvents();

    const result = await reconcile(events, events);

    expect(result.eventsProcessed).toBe(0);
    expect(result.details).toBe("Found 0 missing events to apply");
  });

  it("should reconcile when remote is a subset of local", async () => {
    const events = await buildChainedEvents();

    // Remote has fewer events
    const remoteEvents = events.slice(0, 5);

    const result = await reconcile(events, remoteEvents);

    // No events missing from local
    expect(result.eventsProcessed).toBe(0);
  });

  it("should handle empty event lists in rebuild and verify", async () => {
    const verifyResult = await verify([], verifyChain);
    expect(verifyResult.success).toBe(true);
    expect(verifyResult.eventsProcessed).toBe(0);

    const { result, state } = await rebuild([], rootReducer, { ...initialRootState });
    expect(result.success).toBe(true);
    expect(result.eventsProcessed).toBe(0);
    expect(JSON.stringify(state)).toBe(JSON.stringify(initialRootState));
  });

  it("full recovery pipeline: verify -> detect corruption -> rebuild from clean events", async () => {
    const events = await buildChainedEvents();

    // Step 1: Verify original chain
    const step1 = await verify(events, verifyChain);
    expect(step1.success).toBe(true);

    // Step 2: Build reference state
    const { state: referenceState } = await rebuild(events, rootReducer, { ...initialRootState });

    // Step 3: Introduce corruption
    const corruptedEvents = events.map((e) => ({ ...e }));
    corruptedEvents[4].payload_json = JSON.stringify({ evil: "payload" });

    // Step 4: Detect corruption
    const step4 = await verify(corruptedEvents, verifyChain);
    expect(step4.success).toBe(false);
    expect(step4.details).toContain("Chain broken at index 4");

    // Step 5: Rebuild from original clean events
    const { state: rebuiltState } = await rebuild(events, rootReducer, { ...initialRootState });

    // Step 6: Verify rebuilt matches reference
    const step6 = await replay(events, rootReducer, { ...initialRootState }, referenceState);
    expect(step6.success).toBe(true);

    // Step 7: Final state check
    expect(JSON.stringify(rebuiltState)).toBe(JSON.stringify(referenceState));
  });
});
