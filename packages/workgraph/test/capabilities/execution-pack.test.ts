import { describe, it, expect } from "bun:test";
import { executionPack } from "../src/execution-pack";
import type { NodeExecutionContext } from "@opencode-ai/orchestrator-core/src/capabilities";

const baseContext: NodeExecutionContext = {
  nodeId: "n1",
  runId: "run1",
  teamId: "team1",
  kind: "team_task",
  inputs: {},
  scratchpad: {},
};

describe("Execution Pack", () => {
  it("should have correct pack structure", () => {
    expect(executionPack.id).toBe("execution");
    expect(executionPack.name).toBe("Execution Capability");
    expect(executionPack.roles).toHaveLength(2);
    expect(executionPack.nodeHandlers.size).toBe(2);
  });

  it("should have implementer and reviewer roles", () => {
    const roleIds = executionPack.roles.map((r) => r.id);
    expect(roleIds).toContain("implementer");
    expect(roleIds).toContain("reviewer");
  });

  it("should have handlers for team_task and synthesis_task", () => {
    expect(executionPack.nodeHandlers.has("team_task")).toBe(true);
    expect(executionPack.nodeHandlers.has("synthesis_task")).toBe(true);
  });

  describe("implementation handler", () => {
    it("should execute and return completed status", async () => {
      const handler = executionPack.nodeHandlers.get("team_task")!;
      const result = await handler.execute(baseContext);
      expect(result.status).toBe("completed");
      expect(result.outputs.implementation).toContain("n1");
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0].type).toBe("artifact");
    });
  });

  describe("synthesis handler", () => {
    it("should collect inputs and produce consolidated output", async () => {
      const handler = executionPack.nodeHandlers.get("synthesis_task")!;
      const result = await handler.execute({
        ...baseContext,
        kind: "synthesis_task",
        inputs: {
          research: { summary: "Research findings" },
          implementation: { code: "const x = 1;" },
        },
      });
      expect(result.status).toBe("completed");
      expect(result.outputs.synthesis).toContain("2 input(s)");
      expect(result.outputs.consolidated).toHaveProperty("research");
      expect(result.outputs.consolidated).toHaveProperty("implementation");
      expect(result.evidence).toHaveLength(2);
    });

    it("should handle empty inputs gracefully", async () => {
      const handler = executionPack.nodeHandlers.get("synthesis_task")!;
      const result = await handler.execute({
        ...baseContext,
        kind: "synthesis_task",
        inputs: {},
      });
      expect(result.status).toBe("completed");
      expect(result.outputs.synthesis).toContain("0 input(s)");
      expect(result.evidence).toHaveLength(0);
    });
  });
});
