import { describe, it, expect } from "bun:test";
import { GateTracker } from "../src/orchestrator/graph/gates";

describe("GateTracker", () => {
  describe("satisfy / isSatisfied", () => {
    it("should mark a gate as satisfied", () => {
      const tracker = new GateTracker();
      tracker.satisfy("producer", "consumer");
      expect(tracker.isSatisfied("producer", "consumer")).toBe(true);
    });

    it("should return false for unsatisfied gates", () => {
      const tracker = new GateTracker();
      expect(tracker.isSatisfied("producer", "consumer")).toBe(false);
    });

    it("should handle multiple independent gates", () => {
      const tracker = new GateTracker();
      tracker.satisfy("a", "b");
      tracker.satisfy("c", "d");
      expect(tracker.isSatisfied("a", "b")).toBe(true);
      expect(tracker.isSatisfied("c", "d")).toBe(true);
      expect(tracker.isSatisfied("a", "d")).toBe(false);
    });
  });

  describe("reopen", () => {
    it("should reopen a previously satisfied gate", () => {
      const tracker = new GateTracker();
      tracker.satisfy("a", "b");
      expect(tracker.isSatisfied("a", "b")).toBe(true);
      tracker.reopen("a", "b");
      expect(tracker.isSatisfied("a", "b")).toBe(false);
    });

    it("should be a no-op for gates that were never satisfied", () => {
      const tracker = new GateTracker();
      tracker.reopen("x", "y"); // should not throw
      expect(tracker.isSatisfied("x", "y")).toBe(false);
    });
  });

  describe("getSatisfiedCount", () => {
    it("should return 0 when no gates are satisfied", () => {
      const tracker = new GateTracker();
      expect(tracker.getSatisfiedCount()).toBe(0);
    });

    it("should return correct count after satisfying gates", () => {
      const tracker = new GateTracker();
      tracker.satisfy("a", "b");
      tracker.satisfy("c", "d");
      tracker.satisfy("e", "f");
      expect(tracker.getSatisfiedCount()).toBe(3);
    });

    it("should decrease count after reopening", () => {
      const tracker = new GateTracker();
      tracker.satisfy("a", "b");
      tracker.satisfy("c", "d");
      tracker.reopen("a", "b");
      expect(tracker.getSatisfiedCount()).toBe(1);
    });

    it("should not double-count when satisfying the same gate twice", () => {
      const tracker = new GateTracker();
      tracker.satisfy("a", "b");
      tracker.satisfy("a", "b");
      expect(tracker.getSatisfiedCount()).toBe(1);
    });
  });

  describe("clear", () => {
    it("should remove all satisfied gates", () => {
      const tracker = new GateTracker();
      tracker.satisfy("a", "b");
      tracker.satisfy("c", "d");
      tracker.clear();
      expect(tracker.getSatisfiedCount()).toBe(0);
      expect(tracker.isSatisfied("a", "b")).toBe(false);
      expect(tracker.isSatisfied("c", "d")).toBe(false);
    });
  });

  describe("key format verification", () => {
    it("should use sourceId:targetId format (different directions are different gates)", () => {
      const tracker = new GateTracker();
      tracker.satisfy("a", "b");
      expect(tracker.isSatisfied("a", "b")).toBe(true);
      expect(tracker.isSatisfied("b", "a")).toBe(false);
    });

    it("should handle ids with special characters", () => {
      const tracker = new GateTracker();
      tracker.satisfy("team-1", "task-2");
      expect(tracker.isSatisfied("team-1", "task-2")).toBe(true);
      expect(tracker.isSatisfied("team", "1:task-2")).toBe(false);
    });
  });
});
