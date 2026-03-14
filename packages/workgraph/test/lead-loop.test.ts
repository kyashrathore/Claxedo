import { describe, it, expect, beforeEach } from "bun:test";
import { LeadLoop } from "../src/orchestrator/core/services/lead-loop";

describe("LeadLoop", () => {
  let loop: LeadLoop;

  beforeEach(() => {
    loop = new LeadLoop();
  });

  describe("detectGaps", () => {
    it("should detect gaps for stale active nodes", () => {
      const now = Date.now();
      const nodes = [
        {
          id: "node_1",
          status: "active",
          lastActivityAt: now - 200_000, // 200s ago, exceeds default 120s timeout
        },
      ];

      const gaps = loop.detectGaps("run_1", nodes);
      expect(gaps.length).toBe(1);
      expect(gaps[0].nodeId).toBe("node_1");
      expect(gaps[0].runId).toBe("run_1");
      expect(gaps[0].reason).toContain("No progress for");
    });

    it("should not detect gaps for recently active nodes", () => {
      const now = Date.now();
      const nodes = [
        {
          id: "node_1",
          status: "active",
          lastActivityAt: now - 30_000, // 30s ago, within 120s timeout
        },
      ];

      const gaps = loop.detectGaps("run_1", nodes);
      expect(gaps.length).toBe(0);
    });

    it("should not detect gaps for completed nodes", () => {
      const now = Date.now();
      const nodes = [
        {
          id: "node_1",
          status: "completed",
          lastActivityAt: now - 200_000,
        },
      ];

      const gaps = loop.detectGaps("run_1", nodes);
      expect(gaps.length).toBe(0);
    });

    it("should not detect gaps for failed nodes", () => {
      const now = Date.now();
      const nodes = [
        {
          id: "node_1",
          status: "failed",
          lastActivityAt: now - 200_000,
        },
      ];

      const gaps = loop.detectGaps("run_1", nodes);
      expect(gaps.length).toBe(0);
    });

    it("should use custom timeout", () => {
      const now = Date.now();
      const nodes = [
        {
          id: "node_1",
          status: "active",
          lastActivityAt: now - 50_000, // 50s ago
        },
      ];

      // With 30s timeout, should detect
      const gaps30 = loop.detectGaps("run_1", nodes, 30_000);
      expect(gaps30.length).toBe(1);

      // With 60s timeout, should detect
      const newLoop = new LeadLoop();
      const gaps60 = newLoop.detectGaps("run_1", nodes, 60_000);
      expect(gaps60.length).toBe(0);
    });

    it("should accumulate gaps across multiple calls", () => {
      const now = Date.now();
      const nodes1 = [
        { id: "node_1", status: "active", lastActivityAt: now - 200_000 },
      ];
      const nodes2 = [
        { id: "node_2", status: "active", lastActivityAt: now - 200_000 },
      ];

      loop.detectGaps("run_1", nodes1);
      loop.detectGaps("run_1", nodes2);

      const allGaps = loop.getGaps("run_1");
      expect(allGaps.length).toBe(2);
    });

    it("should not flag active nodes without lastActivityAt", () => {
      const nodes = [
        { id: "node_1", status: "active" }, // no lastActivityAt
      ];

      const gaps = loop.detectGaps("run_1", nodes);
      expect(gaps.length).toBe(0);
    });

    it("should not flag pending nodes", () => {
      const now = Date.now();
      const nodes = [
        { id: "node_1", status: "pending", lastActivityAt: now - 200_000 },
      ];

      const gaps = loop.detectGaps("run_1", nodes);
      expect(gaps.length).toBe(0);
    });
  });

  describe("requestReroute", () => {
    it("should create a reroute request", () => {
      const reroute = loop.requestReroute(
        "run_1",
        "node_1",
        "team_2",
        "Node is stuck, reassigning"
      );

      expect(reroute.runId).toBe("run_1");
      expect(reroute.fromNodeId).toBe("node_1");
      expect(reroute.toTeamId).toBe("team_2");
      expect(reroute.reason).toBe("Node is stuck, reassigning");
      expect(reroute.requestedAt).toBeTruthy();
      expect(reroute.id).toContain("reroute_node_1");
    });
  });

  describe("getGaps", () => {
    it("should return gaps for a specific run", () => {
      const now = Date.now();
      loop.detectGaps("run_1", [
        { id: "node_1", status: "active", lastActivityAt: now - 200_000 },
      ]);
      loop.detectGaps("run_2", [
        { id: "node_2", status: "active", lastActivityAt: now - 200_000 },
      ]);

      const gaps = loop.getGaps("run_1");
      expect(gaps.length).toBe(1);
      expect(gaps[0].runId).toBe("run_1");
    });

    it("should return empty array for run with no gaps", () => {
      const gaps = loop.getGaps("run_nonexistent");
      expect(gaps).toEqual([]);
    });
  });

  describe("getReroutes", () => {
    it("should return reroutes for a specific run", () => {
      loop.requestReroute("run_1", "node_1", "team_2", "Reason 1");
      loop.requestReroute("run_1", "node_2", "team_3", "Reason 2");
      loop.requestReroute("run_2", "node_3", "team_1", "Different run");

      const reroutes = loop.getReroutes("run_1");
      expect(reroutes.length).toBe(2);
    });

    it("should return empty array for run with no reroutes", () => {
      const reroutes = loop.getReroutes("run_nonexistent");
      expect(reroutes).toEqual([]);
    });
  });
});
