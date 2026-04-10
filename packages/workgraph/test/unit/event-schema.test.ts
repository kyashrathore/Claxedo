import { describe, it, expect } from "vitest";
import { EventEnvelopeSchema } from "../../src/orchestrator/events/schema";
import { EVENT_TYPES } from "../../src/orchestrator/events/event-types";

// ---------------------------------------------------------------------------
// EVENT_TYPES
// ---------------------------------------------------------------------------

describe("EVENT_TYPES", () => {
  it("covers run lifecycle", () => {
    expect(EVENT_TYPES.RUN_CREATED).toBe("run_created");
    expect(EVENT_TYPES.RUN_PLANNED).toBe("run_planned");
  });

  it("covers graph structure events", () => {
    expect(EVENT_TYPES.NODE_CREATED).toBe("node_created");
    expect(EVENT_TYPES.NODE_STATUS_CHANGED).toBe("node_status_changed");
    expect(EVENT_TYPES.EDGE_ADDED).toBe("edge_added");
    expect(EVENT_TYPES.EDGE_REMOVED).toBe("edge_removed");
  });

  it("covers gate events", () => {
    expect(EVENT_TYPES.GATE_SATISFIED).toBe("gate_satisfied");
    expect(EVENT_TYPES.GATE_REOPENED).toBe("gate_reopened");
  });

  it("covers scratchpad events", () => {
    expect(EVENT_TYPES.SCRATCHPAD_WRITTEN).toBe("scratchpad_written");
    expect(EVENT_TYPES.SCRATCHPAD_PROMOTED).toBe("scratchpad_promoted");
    expect(EVENT_TYPES.SCRATCHPAD_DISMISSED).toBe("scratchpad_dismissed");
  });

  it("covers artifact and execution events", () => {
    expect(EVENT_TYPES.ARTIFACT_CREATED).toBe("artifact_created");
    expect(EVENT_TYPES.DISPATCH_REQUESTED).toBe("dispatch_requested");
  });

  it("covers hydration events", () => {
    expect(EVENT_TYPES.ISSUE_HYDRATED).toBe("issue_hydrated");
    expect(EVENT_TYPES.ISSUE_UPDATED).toBe("issue_updated");
    expect(EVENT_TYPES.ISSUE_LINKED).toBe("issue_linked");
    expect(EVENT_TYPES.ISSUE_COMMENT_ADDED).toBe("issue_comment_added");
  });

  it("covers sync protocol events", () => {
    expect(EVENT_TYPES.SYNC_PUSH_ACKED).toBe("sync_push_acked");
    expect(EVENT_TYPES.SYNC_PULL_APPLIED).toBe("sync_pull_applied");
    expect(EVENT_TYPES.CONFLICT_DETECTED).toBe("conflict_detected");
    expect(EVENT_TYPES.CONFLICT_RESOLVED).toBe("conflict_resolved");
    expect(EVENT_TYPES.SNAPSHOT_CREATED).toBe("snapshot_created");
    expect(EVENT_TYPES.REPAIR_REBUILD_COMPLETED).toBe("repair_rebuild_completed");
  });

  it("covers trigger events", () => {
    expect(EVENT_TYPES.TRIGGER_CREATED).toBe("trigger_created");
    expect(EVENT_TYPES.TRIGGER_UPDATED).toBe("trigger_updated");
    expect(EVENT_TYPES.TRIGGER_DELETED).toBe("trigger_deleted");
    expect(EVENT_TYPES.TRIGGER_FIRED).toBe("trigger_fired");
  });
});

// ---------------------------------------------------------------------------
// EventEnvelopeSchema
// ---------------------------------------------------------------------------

describe("EventEnvelopeSchema", () => {
  const valid = {
    id: "evt_01",
    run_id: "run_01",
    stream_id: "run_01",
    stream_seq: 0,
    logical_ts: 0,
    schema_version: 1,
    type: "run_created",
    payload_json: "{}",
    actor_type: "system",
    actor_id: "orchestrator",
    op_id: "op_01",
    prev_hash: "00000000",
    hash: "abcdef12",
    created_at: "2026-01-01T00:00:00.000Z",
  };

  it("accepts a valid envelope", () => {
    expect(EventEnvelopeSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts stream_seq of 0 (nonnegative boundary)", () => {
    expect(EventEnvelopeSchema.safeParse({ ...valid, stream_seq: 0 }).success).toBe(true);
  });

  it("rejects negative stream_seq", () => {
    expect(EventEnvelopeSchema.safeParse({ ...valid, stream_seq: -1 }).success).toBe(false);
  });

  it("rejects negative logical_ts", () => {
    expect(EventEnvelopeSchema.safeParse({ ...valid, logical_ts: -1 }).success).toBe(false);
  });

  it("rejects schema_version 0 (must be positive)", () => {
    expect(EventEnvelopeSchema.safeParse({ ...valid, schema_version: 0 }).success).toBe(false);
  });

  it("rejects non-integer schema_version", () => {
    expect(EventEnvelopeSchema.safeParse({ ...valid, schema_version: 1.5 }).success).toBe(false);
  });

  it("rejects invalid created_at datetime", () => {
    expect(EventEnvelopeSchema.safeParse({ ...valid, created_at: "not-a-date" }).success).toBe(false);
  });

  it("rejects missing id", () => {
    const { id, ...without } = valid;
    expect(EventEnvelopeSchema.safeParse(without).success).toBe(false);
  });

  it("rejects missing run_id", () => {
    const { run_id, ...without } = valid;
    expect(EventEnvelopeSchema.safeParse(without).success).toBe(false);
  });

  it("parse preserves created_at as string (no Date coercion)", () => {
    const result = EventEnvelopeSchema.parse(valid);
    expect(typeof result.created_at).toBe("string");
  });
});
