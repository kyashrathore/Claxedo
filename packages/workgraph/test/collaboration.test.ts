import { describe, it, expect, beforeEach } from "bun:test";
import { CollaborationService } from "../src/services/collaboration";
import type { MessageType } from "../src/services/collaboration";

describe("CollaborationService", () => {
  let collab: CollaborationService;

  beforeEach(() => {
    collab = new CollaborationService();
  });

  describe("postMessage", () => {
    it("should create a message with createdAt timestamp", () => {
      const msg = collab.postMessage({
        id: "msg_1",
        runId: "run_1",
        teamId: "team_1",
        senderId: "agent_1",
        type: "ask",
        content: "How should we implement this?",
      });

      expect(msg.id).toBe("msg_1");
      expect(msg.runId).toBe("run_1");
      expect(msg.teamId).toBe("team_1");
      expect(msg.senderId).toBe("agent_1");
      expect(msg.type).toBe("ask");
      expect(msg.content).toBe("How should we implement this?");
      expect(msg.createdAt).toBeTruthy();
    });

    it("should support replyTo field", () => {
      const msg = collab.postMessage({
        id: "msg_2",
        runId: "run_1",
        teamId: "team_1",
        senderId: "agent_2",
        type: "answer",
        content: "Use a factory pattern",
        replyTo: "msg_1",
      });

      expect(msg.replyTo).toBe("msg_1");
    });
  });

  describe("getMessages", () => {
    it("should return all messages for a run", () => {
      collab.postMessage({
        id: "msg_1",
        runId: "run_1",
        teamId: "team_1",
        senderId: "agent_1",
        type: "ask",
        content: "Question 1",
      });
      collab.postMessage({
        id: "msg_2",
        runId: "run_1",
        teamId: "team_2",
        senderId: "agent_2",
        type: "answer",
        content: "Answer 1",
      });
      collab.postMessage({
        id: "msg_3",
        runId: "run_2",
        teamId: "team_1",
        senderId: "agent_1",
        type: "propose",
        content: "Different run",
      });

      const msgs = collab.getMessages("run_1");
      expect(msgs.length).toBe(2);
    });

    it("should filter by teamId when provided", () => {
      collab.postMessage({
        id: "msg_1",
        runId: "run_1",
        teamId: "team_1",
        senderId: "agent_1",
        type: "ask",
        content: "From team 1",
      });
      collab.postMessage({
        id: "msg_2",
        runId: "run_1",
        teamId: "team_2",
        senderId: "agent_2",
        type: "answer",
        content: "From team 2",
      });

      const msgs = collab.getMessages("run_1", "team_1");
      expect(msgs.length).toBe(1);
      expect(msgs[0].teamId).toBe("team_1");
    });

    it("should return empty array for unknown run", () => {
      const msgs = collab.getMessages("run_nonexistent");
      expect(msgs).toEqual([]);
    });
  });

  describe("getMessagesByType", () => {
    it("should filter messages by type", () => {
      collab.postMessage({
        id: "msg_1",
        runId: "run_1",
        teamId: "team_1",
        senderId: "agent_1",
        type: "ask",
        content: "Question",
      });
      collab.postMessage({
        id: "msg_2",
        runId: "run_1",
        teamId: "team_1",
        senderId: "agent_2",
        type: "answer",
        content: "Answer",
      });
      collab.postMessage({
        id: "msg_3",
        runId: "run_1",
        teamId: "team_1",
        senderId: "agent_3",
        type: "ask",
        content: "Another question",
      });

      const asks = collab.getMessagesByType("run_1", "ask");
      expect(asks.length).toBe(2);

      const answers = collab.getMessagesByType("run_1", "answer");
      expect(answers.length).toBe(1);
    });

    it("should support all message types", () => {
      const types: MessageType[] = [
        "ask",
        "answer",
        "propose",
        "challenge",
        "blocker",
      ];

      for (const type of types) {
        collab.postMessage({
          id: `msg_${type}`,
          runId: "run_1",
          teamId: "team_1",
          senderId: "agent_1",
          type,
          content: `Message of type ${type}`,
        });
      }

      for (const type of types) {
        const msgs = collab.getMessagesByType("run_1", type);
        expect(msgs.length).toBe(1);
        expect(msgs[0].type).toBe(type);
      }
    });
  });

  describe("Handoff lifecycle", () => {
    it("should create a pending handoff", () => {
      const handoff = collab.requestHandoff({
        id: "h_1",
        runId: "run_1",
        fromTeamId: "team_1",
        toTeamId: "team_2",
        payload: "Take over frontend work",
      });

      expect(handoff.id).toBe("h_1");
      expect(handoff.status).toBe("pending");
      expect(handoff.fromTeamId).toBe("team_1");
      expect(handoff.toTeamId).toBe("team_2");
      expect(handoff.payload).toBe("Take over frontend work");
      expect(handoff.createdAt).toBeTruthy();
    });

    it("should accept a pending handoff", () => {
      collab.requestHandoff({
        id: "h_1",
        runId: "run_1",
        fromTeamId: "team_1",
        toTeamId: "team_2",
        payload: "Take over",
      });

      const accepted = collab.acceptHandoff("h_1");
      expect(accepted).toBeTruthy();
      expect(accepted!.status).toBe("accepted");
      expect(accepted!.resolvedAt).toBeTruthy();
    });

    it("should reject a pending handoff", () => {
      collab.requestHandoff({
        id: "h_1",
        runId: "run_1",
        fromTeamId: "team_1",
        toTeamId: "team_2",
        payload: "Take over",
      });

      const rejected = collab.rejectHandoff("h_1");
      expect(rejected).toBeTruthy();
      expect(rejected!.status).toBe("rejected");
      expect(rejected!.resolvedAt).toBeTruthy();
    });

    it("should not accept an already accepted handoff", () => {
      collab.requestHandoff({
        id: "h_1",
        runId: "run_1",
        fromTeamId: "team_1",
        toTeamId: "team_2",
        payload: "Take over",
      });

      collab.acceptHandoff("h_1");
      const result = collab.acceptHandoff("h_1");
      expect(result).toBeNull();
    });

    it("should not reject an already rejected handoff", () => {
      collab.requestHandoff({
        id: "h_1",
        runId: "run_1",
        fromTeamId: "team_1",
        toTeamId: "team_2",
        payload: "Take over",
      });

      collab.rejectHandoff("h_1");
      const result = collab.rejectHandoff("h_1");
      expect(result).toBeNull();
    });

    it("should return null when accepting nonexistent handoff", () => {
      const result = collab.acceptHandoff("h_nonexistent");
      expect(result).toBeNull();
    });

    it("should return null when rejecting nonexistent handoff", () => {
      const result = collab.rejectHandoff("h_nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("getHandoff / getHandoffs", () => {
    it("should retrieve a handoff by ID", () => {
      collab.requestHandoff({
        id: "h_1",
        runId: "run_1",
        fromTeamId: "team_1",
        toTeamId: "team_2",
        payload: "Work item",
      });

      const h = collab.getHandoff("h_1");
      expect(h).toBeTruthy();
      expect(h!.id).toBe("h_1");
    });

    it("should return undefined for unknown handoff ID", () => {
      const h = collab.getHandoff("h_nonexistent");
      expect(h).toBeUndefined();
    });

    it("should return all handoffs for a run", () => {
      collab.requestHandoff({
        id: "h_1",
        runId: "run_1",
        fromTeamId: "team_1",
        toTeamId: "team_2",
        payload: "Item 1",
      });
      collab.requestHandoff({
        id: "h_2",
        runId: "run_1",
        fromTeamId: "team_2",
        toTeamId: "team_3",
        payload: "Item 2",
      });
      collab.requestHandoff({
        id: "h_3",
        runId: "run_2",
        fromTeamId: "team_1",
        toTeamId: "team_2",
        payload: "Different run",
      });

      const handoffs = collab.getHandoffs("run_1");
      expect(handoffs.length).toBe(2);
    });
  });
});
