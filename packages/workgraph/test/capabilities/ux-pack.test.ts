import { describe, it, expect } from "bun:test";
import { uxPack } from "../src/ux-pack";
import type { NodeExecutionContext } from "@opencode-ai/orchestrator-core/src/capabilities";

const baseContext: NodeExecutionContext = {
  nodeId: "n1",
  runId: "run1",
  teamId: "team1",
  kind: "agent_task",
  inputs: {},
  scratchpad: {},
};

describe("UX Pack", () => {
  it("should have correct pack structure", () => {
    expect(uxPack.id).toBe("ux");
    expect(uxPack.name).toBe("UX Capability");
    expect(uxPack.roles).toHaveLength(2);
    expect(uxPack.nodeHandlers.size).toBe(1);
  });

  it("should have designer and prototyper roles", () => {
    const roleIds = uxPack.roles.map((r) => r.id);
    expect(roleIds).toContain("designer");
    expect(roleIds).toContain("prototyper");
  });

  it("should have handler for agent_task", () => {
    expect(uxPack.nodeHandlers.has("agent_task")).toBe(true);
  });

  describe("ux handler", () => {
    it("should execute and return completed status", async () => {
      const handler = uxPack.nodeHandlers.get("agent_task")!;
      const result = await handler.execute(baseContext);
      expect(result.status).toBe("completed");
      expect(result.outputs.design).toContain("n1");
      expect(result.outputs.wireframes).toEqual([]);
      expect(result.outputs.guidelines).toEqual([]);
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0].type).toBe("artifact");
    });
  });
});
