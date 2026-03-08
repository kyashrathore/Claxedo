import { describe, it, expect } from "bun:test";
import { EVENT_TYPES, type EventType } from "../src/event-types";

describe("EVENT_TYPES", () => {
  it("should have all expected event type constants", () => {
    expect(EVENT_TYPES.RUN_CREATED).toBe("run_created");
    expect(EVENT_TYPES.RUN_PLANNED).toBe("run_planned");
    expect(EVENT_TYPES.TEAM_CREATED).toBe("team_created");
    expect(EVENT_TYPES.TEAM_STATUS_CHANGED).toBe("team_status_changed");
    expect(EVENT_TYPES.TEAM_MEMBER_ADDED).toBe("team_member_added");
    expect(EVENT_TYPES.NODE_CREATED).toBe("node_created");
    expect(EVENT_TYPES.NODE_STATUS_CHANGED).toBe("node_status_changed");
    expect(EVENT_TYPES.EDGE_ADDED).toBe("edge_added");
    expect(EVENT_TYPES.EDGE_REMOVED).toBe("edge_removed");
    expect(EVENT_TYPES.GATE_SATISFIED).toBe("gate_satisfied");
    expect(EVENT_TYPES.GATE_REOPENED).toBe("gate_reopened");
    expect(EVENT_TYPES.MESSAGE_POSTED).toBe("message_posted");
    expect(EVENT_TYPES.HANDOFF_REQUESTED).toBe("handoff_requested");
    expect(EVENT_TYPES.HANDOFF_ACCEPTED).toBe("handoff_accepted");
    expect(EVENT_TYPES.HANDOFF_REJECTED).toBe("handoff_rejected");
    expect(EVENT_TYPES.QUESTION_ASKED).toBe("question_asked");
    expect(EVENT_TYPES.QUESTION_ANSWERED).toBe("question_answered");
    expect(EVENT_TYPES.LEAD_PLAN_CREATED).toBe("lead_plan_created");
    expect(EVENT_TYPES.LEAD_GAP_DETECTED).toBe("lead_gap_detected");
    expect(EVENT_TYPES.LEAD_REROUTE_REQUESTED).toBe("lead_reroute_requested");
    expect(EVENT_TYPES.REACTION_TRIGGERED).toBe("reaction_triggered");
    expect(EVENT_TYPES.WATCHDOG_ESCALATED).toBe("watchdog_escalated");
    expect(EVENT_TYPES.FEATURE_SLICE_HYDRATED).toBe("feature_slice_hydrated");
    expect(EVENT_TYPES.ISSUE_HYDRATED).toBe("issue_hydrated");
    expect(EVENT_TYPES.ISSUE_UPDATED).toBe("issue_updated");
    expect(EVENT_TYPES.ISSUE_LINKED).toBe("issue_linked");
    expect(EVENT_TYPES.ISSUE_COMMENT_ADDED).toBe("issue_comment_added");
    expect(EVENT_TYPES.QUESTION_SCOPED).toBe("question_scoped");
    expect(EVENT_TYPES.ROUTE_SCORED).toBe("route_scored");
    expect(EVENT_TYPES.ROUTE_SELECTED).toBe("route_selected");
    expect(EVENT_TYPES.DISPATCH_REQUESTED).toBe("dispatch_requested");
    expect(EVENT_TYPES.SCRATCHPAD_WRITTEN).toBe("scratchpad_written");
    expect(EVENT_TYPES.SCRATCHPAD_PROMOTED).toBe("scratchpad_promoted");
    expect(EVENT_TYPES.ARTIFACT_CREATED).toBe("artifact_created");
    expect(EVENT_TYPES.DECISION_PROPOSED).toBe("decision_proposed");
    expect(EVENT_TYPES.DECISION_CHALLENGED).toBe("decision_challenged");
    expect(EVENT_TYPES.DECISION_ACCEPTED).toBe("decision_accepted");
    expect(EVENT_TYPES.DECISION_REJECTED).toBe("decision_rejected");
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
