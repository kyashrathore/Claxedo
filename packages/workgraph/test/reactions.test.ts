import { describe, it, expect } from "bun:test";
import { ReactionEngine, type ReactionRule } from "../src/services/reactions";

describe("ReactionEngine", () => {
  it("should add and retrieve rules", () => {
    const engine = new ReactionEngine();
    const rule: ReactionRule = {
      id: "rule-1",
      trigger: "node_status_changed",
      condition: () => true,
      action: () => ({ type: "notify", payload: {} }),
      cooldownMs: 0,
    };

    engine.addRule(rule);
    expect(engine.getRules()).toHaveLength(1);
    expect(engine.getRules()[0].id).toBe("rule-1");
  });

  it("should remove a rule by id", () => {
    const engine = new ReactionEngine();
    engine.addRule({
      id: "rule-1",
      trigger: "test",
      condition: () => true,
      action: () => ({ type: "a", payload: {} }),
      cooldownMs: 0,
    });
    engine.addRule({
      id: "rule-2",
      trigger: "test",
      condition: () => true,
      action: () => ({ type: "b", payload: {} }),
      cooldownMs: 0,
    });

    engine.removeRule("rule-1");
    expect(engine.getRules()).toHaveLength(1);
    expect(engine.getRules()[0].id).toBe("rule-2");
  });

  it("should evaluate matching rules and return actions", () => {
    const engine = new ReactionEngine();
    engine.addRule({
      id: "rule-1",
      trigger: "node_status_changed",
      condition: (_event, state) => state.nodeCount > 5,
      action: (event) => ({ type: "scale_up", payload: { nodeId: event.nodeId } }),
      cooldownMs: 0,
    });

    const event = { type: "node_status_changed", nodeId: "node-1" };
    const state = { nodeCount: 10 };
    const results = engine.evaluate(event, state);

    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe("rule-1");
    expect(results[0].action.type).toBe("scale_up");
    expect(results[0].action.payload.nodeId).toBe("node-1");
  });

  it("should not fire rules when trigger does not match", () => {
    const engine = new ReactionEngine();
    engine.addRule({
      id: "rule-1",
      trigger: "node_status_changed",
      condition: () => true,
      action: () => ({ type: "notify", payload: {} }),
      cooldownMs: 0,
    });

    const event = { type: "message_posted" };
    const results = engine.evaluate(event, {});
    expect(results).toHaveLength(0);
  });

  it("should not fire rules when condition returns false", () => {
    const engine = new ReactionEngine();
    engine.addRule({
      id: "rule-1",
      trigger: "node_status_changed",
      condition: () => false,
      action: () => ({ type: "notify", payload: {} }),
      cooldownMs: 0,
    });

    const event = { type: "node_status_changed" };
    const results = engine.evaluate(event, {});
    expect(results).toHaveLength(0);
  });

  it("should respect cooldown period", async () => {
    const engine = new ReactionEngine();
    engine.addRule({
      id: "rule-1",
      trigger: "test_event",
      condition: () => true,
      action: () => ({ type: "action", payload: {} }),
      cooldownMs: 5000,
    });

    const event = { type: "test_event" };

    // First evaluation should fire
    const results1 = engine.evaluate(event, {});
    expect(results1).toHaveLength(1);

    // Second evaluation immediately after should be blocked by cooldown
    const results2 = engine.evaluate(event, {});
    expect(results2).toHaveLength(0);
  });

  it("should evaluate multiple rules for the same trigger", () => {
    const engine = new ReactionEngine();
    engine.addRule({
      id: "rule-1",
      trigger: "test_event",
      condition: () => true,
      action: () => ({ type: "action_a", payload: {} }),
      cooldownMs: 0,
    });
    engine.addRule({
      id: "rule-2",
      trigger: "test_event",
      condition: () => true,
      action: () => ({ type: "action_b", payload: {} }),
      cooldownMs: 0,
    });

    const event = { type: "test_event" };
    const results = engine.evaluate(event, {});
    expect(results).toHaveLength(2);
    expect(results[0].action.type).toBe("action_a");
    expect(results[1].action.type).toBe("action_b");
  });

  it("should return a copy of rules, not the internal array", () => {
    const engine = new ReactionEngine();
    engine.addRule({
      id: "rule-1",
      trigger: "test",
      condition: () => true,
      action: () => ({ type: "a", payload: {} }),
      cooldownMs: 0,
    });

    const rules = engine.getRules();
    rules.push({
      id: "rule-fake",
      trigger: "test",
      condition: () => true,
      action: () => ({ type: "b", payload: {} }),
      cooldownMs: 0,
    });

    expect(engine.getRules()).toHaveLength(1);
  });
});
