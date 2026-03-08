import { describe, it, expect, beforeEach } from "bun:test";
import { CollaborationService, type MessageType, type HandoffStatus } from "../../src/services/collaboration";
import { LeadLoop } from "../../src/services/lead-loop";

describe("Collaboration Flow Integration", () => {
  let collaboration: CollaborationService;
  let leadLoop: LeadLoop;

  beforeEach(() => {
    collaboration = new CollaborationService();
    leadLoop = new LeadLoop();
  });

  describe("Message posting and filtering", () => {
    it("should post messages of different types and retrieve them", () => {
      collaboration.postMessage({
        id: "msg_1",
        runId: "run_1",
        teamId: "team_fe",
        senderId: "agent_ui",
        type: "ask",
        content: "What CSS framework should we use?",
      });

      collaboration.postMessage({
        id: "msg_2",
        runId: "run_1",
        teamId: "team_fe",
        senderId: "agent_review",
        type: "answer",
        content: "Tailwind CSS",
        replyTo: "msg_1",
      });

      collaboration.postMessage({
        id: "msg_3",
        runId: "run_1",
        teamId: "team_be",
        senderId: "agent_api",
        type: "propose",
        content: "Use REST over GraphQL",
      });

      collaboration.postMessage({
        id: "msg_4",
        runId: "run_1",
        teamId: "team_be",
        senderId: "agent_review",
        type: "challenge",
        content: "GraphQL would be more flexible",
      });

      collaboration.postMessage({
        id: "msg_5",
        runId: "run_1",
        teamId: "team_be",
        senderId: "agent_api",
        type: "blocker",
        content: "Database connection pool exhausted",
      });

      // Get all messages for run_1
      const allMessages = collaboration.getMessages("run_1");
      expect(allMessages).toHaveLength(5);

      // Filter by team
      const feMessages = collaboration.getMessages("run_1", "team_fe");
      expect(feMessages).toHaveLength(2);
      expect(feMessages[0].type).toBe("ask");
      expect(feMessages[1].type).toBe("answer");

      const beMessages = collaboration.getMessages("run_1", "team_be");
      expect(beMessages).toHaveLength(3);
    });

    it("should filter messages by type", () => {
      collaboration.postMessage({
        id: "msg_1",
        runId: "run_1",
        teamId: "team_fe",
        senderId: "agent_1",
        type: "ask",
        content: "Question 1",
      });
      collaboration.postMessage({
        id: "msg_2",
        runId: "run_1",
        teamId: "team_be",
        senderId: "agent_2",
        type: "ask",
        content: "Question 2",
      });
      collaboration.postMessage({
        id: "msg_3",
        runId: "run_1",
        teamId: "team_fe",
        senderId: "agent_1",
        type: "propose",
        content: "Proposal 1",
      });

      const asks = collaboration.getMessagesByType("run_1", "ask");
      expect(asks).toHaveLength(2);
      expect(asks[0].content).toBe("Question 1");
      expect(asks[1].content).toBe("Question 2");

      const proposals = collaboration.getMessagesByType("run_1", "propose");
      expect(proposals).toHaveLength(1);

      const blockers = collaboration.getMessagesByType("run_1", "blocker");
      expect(blockers).toHaveLength(0);
    });

    it("should not mix messages from different runs", () => {
      collaboration.postMessage({
        id: "msg_1",
        runId: "run_1",
        teamId: "team_fe",
        senderId: "agent_1",
        type: "ask",
        content: "Run 1 question",
      });
      collaboration.postMessage({
        id: "msg_2",
        runId: "run_2",
        teamId: "team_fe",
        senderId: "agent_1",
        type: "ask",
        content: "Run 2 question",
      });

      expect(collaboration.getMessages("run_1")).toHaveLength(1);
      expect(collaboration.getMessages("run_2")).toHaveLength(1);
      expect(collaboration.getMessages("run_1")[0].content).toBe("Run 1 question");
    });

    it("should set createdAt timestamp automatically", () => {
      const msg = collaboration.postMessage({
        id: "msg_1",
        runId: "run_1",
        teamId: "team_fe",
        senderId: "agent_1",
        type: "ask",
        content: "Test",
      });

      expect(msg.createdAt).toBeDefined();
      // Should be a valid ISO string
      expect(new Date(msg.createdAt).toISOString()).toBe(msg.createdAt);
    });
  });

  describe("Handoff lifecycle", () => {
    it("should create a handoff with pending status", () => {
      const handoff = collaboration.requestHandoff({
        id: "h_1",
        runId: "run_1",
        fromTeamId: "team_fe",
        toTeamId: "team_be",
        payload: "Need API endpoint for auth",
      });

      expect(handoff.id).toBe("h_1");
      expect(handoff.status).toBe("pending");
      expect(handoff.fromTeamId).toBe("team_fe");
      expect(handoff.toTeamId).toBe("team_be");
      expect(handoff.payload).toBe("Need API endpoint for auth");
      expect(handoff.createdAt).toBeDefined();
      expect(handoff.resolvedAt).toBeUndefined();
    });

    it("should complete the request -> accept flow", () => {
      collaboration.requestHandoff({
        id: "h_1",
        runId: "run_1",
        fromTeamId: "team_fe",
        toTeamId: "team_be",
        payload: "Auth API needed",
      });

      const accepted = collaboration.acceptHandoff("h_1");
      expect(accepted).not.toBeNull();
      expect(accepted!.status).toBe("accepted");
      expect(accepted!.resolvedAt).toBeDefined();

      // Verify retrieval
      const h = collaboration.getHandoff("h_1");
      expect(h).toBeDefined();
      expect(h!.status).toBe("accepted");
    });

    it("should complete the request -> reject flow", () => {
      collaboration.requestHandoff({
        id: "h_2",
        runId: "run_1",
        fromTeamId: "team_fe",
        toTeamId: "team_qa",
        payload: "Need QA review",
      });

      const rejected = collaboration.rejectHandoff("h_2");
      expect(rejected).not.toBeNull();
      expect(rejected!.status).toBe("rejected");
      expect(rejected!.resolvedAt).toBeDefined();
    });

    it("should not allow accepting an already accepted handoff", () => {
      collaboration.requestHandoff({
        id: "h_3",
        runId: "run_1",
        fromTeamId: "team_fe",
        toTeamId: "team_be",
        payload: "Payload",
      });

      collaboration.acceptHandoff("h_3");
      const secondAccept = collaboration.acceptHandoff("h_3");
      expect(secondAccept).toBeNull(); // Already accepted, can't accept again
    });

    it("should not allow rejecting an already accepted handoff", () => {
      collaboration.requestHandoff({
        id: "h_4",
        runId: "run_1",
        fromTeamId: "team_fe",
        toTeamId: "team_be",
        payload: "Payload",
      });

      collaboration.acceptHandoff("h_4");
      const rejected = collaboration.rejectHandoff("h_4");
      expect(rejected).toBeNull();
    });

    it("should not allow accepting an already rejected handoff", () => {
      collaboration.requestHandoff({
        id: "h_5",
        runId: "run_1",
        fromTeamId: "team_fe",
        toTeamId: "team_be",
        payload: "Payload",
      });

      collaboration.rejectHandoff("h_5");
      const accepted = collaboration.acceptHandoff("h_5");
      expect(accepted).toBeNull();
    });

    it("should return null for non-existent handoff", () => {
      expect(collaboration.acceptHandoff("nonexistent")).toBeNull();
      expect(collaboration.rejectHandoff("nonexistent")).toBeNull();
    });

    it("should list all handoffs for a run", () => {
      collaboration.requestHandoff({
        id: "h_1",
        runId: "run_1",
        fromTeamId: "team_fe",
        toTeamId: "team_be",
        payload: "P1",
      });
      collaboration.requestHandoff({
        id: "h_2",
        runId: "run_1",
        fromTeamId: "team_be",
        toTeamId: "team_qa",
        payload: "P2",
      });
      collaboration.requestHandoff({
        id: "h_3",
        runId: "run_2",
        fromTeamId: "team_fe",
        toTeamId: "team_be",
        payload: "P3",
      });

      const run1Handoffs = collaboration.getHandoffs("run_1");
      expect(run1Handoffs).toHaveLength(2);

      const run2Handoffs = collaboration.getHandoffs("run_2");
      expect(run2Handoffs).toHaveLength(1);
    });
  });

  describe("LeadLoop gap detection and rerouting", () => {
    it("should detect gaps in stalled active nodes", () => {
      const now = Date.now();
      const nodes = [
        { id: "node_1", status: "active", lastActivityAt: now - 200_000 }, // stalled > 120s
        { id: "node_2", status: "active", lastActivityAt: now - 50_000 }, // not stalled
        { id: "node_3", status: "completed" }, // completed, should be skipped
        { id: "node_4", status: "active", lastActivityAt: now - 150_000 }, // stalled > 120s
      ];

      const gaps = leadLoop.detectGaps("run_1", nodes, 120_000);

      expect(gaps).toHaveLength(2);
      expect(gaps[0].nodeId).toBe("node_1");
      expect(gaps[1].nodeId).toBe("node_4");
      expect(gaps[0].reason).toContain("No progress");
      expect(gaps[0].runId).toBe("run_1");
    });

    it("should not detect gaps for nodes without lastActivityAt", () => {
      const nodes = [
        { id: "node_1", status: "active" }, // no lastActivityAt
      ];

      const gaps = leadLoop.detectGaps("run_1", nodes, 120_000);
      expect(gaps).toHaveLength(0);
    });

    it("should not detect gaps for failed nodes", () => {
      const now = Date.now();
      const nodes = [
        { id: "node_1", status: "failed", lastActivityAt: now - 200_000 },
      ];

      const gaps = leadLoop.detectGaps("run_1", nodes, 120_000);
      expect(gaps).toHaveLength(0);
    });

    it("should request a reroute", () => {
      const reroute = leadLoop.requestReroute(
        "run_1",
        "node_stalled",
        "team_rescue",
        "Node has been stalled for too long"
      );

      expect(reroute.runId).toBe("run_1");
      expect(reroute.fromNodeId).toBe("node_stalled");
      expect(reroute.toTeamId).toBe("team_rescue");
      expect(reroute.reason).toBe("Node has been stalled for too long");
      expect(reroute.requestedAt).toBeDefined();
    });

    it("should accumulate gaps and reroutes across multiple calls", () => {
      const now = Date.now();

      leadLoop.detectGaps("run_1", [
        { id: "n1", status: "active", lastActivityAt: now - 200_000 },
      ], 120_000);

      leadLoop.detectGaps("run_1", [
        { id: "n2", status: "active", lastActivityAt: now - 300_000 },
      ], 120_000);

      leadLoop.requestReroute("run_1", "n1", "team_b", "Stalled");
      leadLoop.requestReroute("run_1", "n2", "team_c", "Also stalled");

      expect(leadLoop.getGaps("run_1")).toHaveLength(2);
      expect(leadLoop.getReroutes("run_1")).toHaveLength(2);
    });

    it("should not mix gaps/reroutes from different runs", () => {
      const now = Date.now();

      leadLoop.detectGaps("run_1", [
        { id: "n1", status: "active", lastActivityAt: now - 200_000 },
      ], 120_000);

      leadLoop.detectGaps("run_2", [
        { id: "n2", status: "active", lastActivityAt: now - 200_000 },
      ], 120_000);

      leadLoop.requestReroute("run_1", "n1", "team_b", "R1");
      leadLoop.requestReroute("run_2", "n2", "team_c", "R2");

      expect(leadLoop.getGaps("run_1")).toHaveLength(1);
      expect(leadLoop.getGaps("run_2")).toHaveLength(1);
      expect(leadLoop.getReroutes("run_1")).toHaveLength(1);
      expect(leadLoop.getReroutes("run_2")).toHaveLength(1);
    });
  });

  describe("Full collaboration lifecycle", () => {
    it("should handle a complete team interaction flow", () => {
      // Step 1: Team asks a question
      const askMsg = collaboration.postMessage({
        id: "msg_ask",
        runId: "run_1",
        teamId: "team_fe",
        senderId: "agent_ui",
        type: "ask",
        content: "Need API spec for user endpoints",
      });

      // Step 2: Another team answers
      const answerMsg = collaboration.postMessage({
        id: "msg_answer",
        runId: "run_1",
        teamId: "team_be",
        senderId: "agent_api",
        type: "answer",
        content: "POST /users, GET /users/:id",
        replyTo: "msg_ask",
      });

      // Step 3: Frontend proposes an approach
      collaboration.postMessage({
        id: "msg_propose",
        runId: "run_1",
        teamId: "team_fe",
        senderId: "agent_ui",
        type: "propose",
        content: "Will implement user form with real-time validation",
      });

      // Step 4: Handoff from frontend to backend
      const handoff = collaboration.requestHandoff({
        id: "h_1",
        runId: "run_1",
        fromTeamId: "team_fe",
        toTeamId: "team_be",
        payload: "UI components ready, need API integration",
      });
      expect(handoff.status).toBe("pending");

      // Step 5: Backend accepts
      const accepted = collaboration.acceptHandoff("h_1");
      expect(accepted!.status).toBe("accepted");

      // Step 6: Backend reports a blocker
      collaboration.postMessage({
        id: "msg_blocker",
        runId: "run_1",
        teamId: "team_be",
        senderId: "agent_api",
        type: "blocker",
        content: "Rate limiting not configured",
      });

      // Verify final state
      const allMsgs = collaboration.getMessages("run_1");
      expect(allMsgs).toHaveLength(4);

      const blockers = collaboration.getMessagesByType("run_1", "blocker");
      expect(blockers).toHaveLength(1);

      const handoffs = collaboration.getHandoffs("run_1");
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0].status).toBe("accepted");
    });

    it("should integrate lead loop gap detection with collaboration flow", () => {
      const now = Date.now();

      // Simulate stalled node
      const stalledNodes = [
        { id: "node_api", status: "active", lastActivityAt: now - 180_000 },
      ];

      // Lead detects gap
      const gaps = leadLoop.detectGaps("run_1", stalledNodes, 120_000);
      expect(gaps).toHaveLength(1);

      // Post a blocker message about the gap
      collaboration.postMessage({
        id: "msg_gap",
        runId: "run_1",
        teamId: "team_be",
        senderId: "lead_agent",
        type: "blocker",
        content: `Gap detected: ${gaps[0].reason}`,
      });

      // Request reroute
      const reroute = leadLoop.requestReroute(
        "run_1",
        "node_api",
        "team_be_backup",
        "Primary team stalled"
      );

      // Create handoff for the reroute
      const handoff = collaboration.requestHandoff({
        id: "h_reroute",
        runId: "run_1",
        fromTeamId: "team_be",
        toTeamId: "team_be_backup",
        payload: `Reroute: ${reroute.reason}`,
      });

      collaboration.acceptHandoff("h_reroute");

      const allHandoffs = collaboration.getHandoffs("run_1");
      expect(allHandoffs).toHaveLength(1);
      expect(allHandoffs[0].status).toBe("accepted");
      expect(allHandoffs[0].toTeamId).toBe("team_be_backup");

      expect(leadLoop.getReroutes("run_1")).toHaveLength(1);
    });
  });
});
