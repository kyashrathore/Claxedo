import { describe, it, expect } from "vitest";
import { EVENT_TYPES, type EventType } from "../src/orchestrator/events/event-types";

describe("EVENT_TYPES", () => {
  it("should have all expected event type constants", () => {
    // Run lifecycle
    expect(EVENT_TYPES.RUN_CREATED).toBe("run_created");
    expect(EVENT_TYPES.RUN_PLANNED).toBe("run_planned");

    // Graph structure
    expect(EVENT_TYPES.NODE_CREATED).toBe("node_created");
    expect(EVENT_TYPES.NODE_STATUS_CHANGED).toBe("node_status_changed");
    expect(EVENT_TYPES.EDGE_ADDED).toBe("edge_added");
    expect(EVENT_TYPES.EDGE_REMOVED).toBe("edge_removed");

    // Gates
    expect(EVENT_TYPES.GATE_SATISFIED).toBe("gate_satisfied");
    expect(EVENT_TYPES.GATE_REOPENED).toBe("gate_reopened");

    // Scratchpad
    expect(EVENT_TYPES.SCRATCHPAD_WRITTEN).toBe("scratchpad_written");
    expect(EVENT_TYPES.SCRATCHPAD_PROMOTED).toBe("scratchpad_promoted");
    expect(EVENT_TYPES.SCRATCHPAD_DISMISSED).toBe("scratchpad_dismissed");

    // Artifacts
    expect(EVENT_TYPES.ARTIFACT_CREATED).toBe("artifact_created");

    // Execution
    expect(EVENT_TYPES.DISPATCH_REQUESTED).toBe("dispatch_requested");

    // Hydration and sync
    expect(EVENT_TYPES.ISSUE_HYDRATED).toBe("issue_hydrated");
    expect(EVENT_TYPES.ISSUE_UPDATED).toBe("issue_updated");
    expect(EVENT_TYPES.ISSUE_LINKED).toBe("issue_linked");
    expect(EVENT_TYPES.ISSUE_COMMENT_ADDED).toBe("issue_comment_added");

    // Sync protocol
    expect(EVENT_TYPES.SYNC_PUSH_ACKED).toBe("sync_push_acked");
    expect(EVENT_TYPES.SYNC_PULL_APPLIED).toBe("sync_pull_applied");
    expect(EVENT_TYPES.CONFLICT_DETECTED).toBe("conflict_detected");
    expect(EVENT_TYPES.CONFLICT_RESOLVED).toBe("conflict_resolved");
    expect(EVENT_TYPES.SNAPSHOT_CREATED).toBe("snapshot_created");
    expect(EVENT_TYPES.REPAIR_REBUILD_COMPLETED).toBe("repair_rebuild_completed");
  });

  it("should have all values as strings", () => {
    for (const [key, value] of Object.entries(EVENT_TYPES)) {
      expect(typeof value).toBe("string");
    }
  });

  it("should have unique values for each constant", () => {
    const values = Object.values(EVENT_TYPES);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });
});
