import { describe, it, expect } from "bun:test";
import { researchPack } from "../src/research-pack";
import type { NodeExecutionContext } from "@opencode-ai/orchestrator-core/src/capabilities";

const baseContext: NodeExecutionContext = {
  nodeId: "n1",
  runId: "run1",
  teamId: "team1",
  kind: "agent_task",
  inputs: {},
  scratchpad: {},
};

describe("Research Pack", () => {
  it("should have correct pack structure", () => {
    expect(researchPack.id).toBe("research");
    expect(researchPack.name).toBe("Research Capability");
    expect(researchPack.roles).toHaveLength(2);
    expect(researchPack.nodeHandlers.size).toBe(2);
  });

  it("should have researcher and fact_checker roles", () => {
    const roleIds = researchPack.roles.map((r) => r.id);
    expect(roleIds).toContain("researcher");
    expect(roleIds).toContain("fact_checker");
  });

  it("should have handlers for agent_task and verification_task", () => {
    expect(researchPack.nodeHandlers.has("agent_task")).toBe(true);
    expect(researchPack.nodeHandlers.has("verification_task")).toBe(true);
  });

  describe("research handler", () => {
    it("should execute and return completed status", async () => {
      const handler = researchPack.nodeHandlers.get("agent_task")!;
      const result = await handler.execute(baseContext);
      expect(result.status).toBe("completed");
      expect(result.outputs.summary).toContain("n1");
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0].type).toBe("document");
    });
  });

  describe("verification handler", () => {
    it("should return needs_review when no inputs provided", async () => {
      const handler = researchPack.nodeHandlers.get("verification_task")!;
      const result = await handler.execute({
        ...baseContext,
        kind: "verification_task",
        inputs: {},
      });
      expect(result.status).toBe("needs_review");
      expect(result.outputs.verified).toBe(false);
      expect(result.outputs.report).toBe("Missing required evidence");
    });

    it("should return completed when inputs are provided", async () => {
      const handler = researchPack.nodeHandlers.get("verification_task")!;
      const result = await handler.execute({
        ...baseContext,
        kind: "verification_task",
        inputs: { research: { summary: "findings" } },
      });
      expect(result.status).toBe("completed");
      expect(result.outputs.verified).toBe(true);
      expect(result.outputs.report).toBe("All inputs verified");
    });
  });
});
