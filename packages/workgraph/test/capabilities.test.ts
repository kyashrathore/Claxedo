import { describe, it, expect } from "bun:test";
import {
  CapabilityRegistry,
  type CapabilityPack,
  type NodeHandler,
  type NodeExecutionContext,
} from "../src/capabilities";

function makeHandler(kind: string): NodeHandler {
  return {
    kind,
    async execute(ctx: NodeExecutionContext) {
      return {
        status: "completed" as const,
        outputs: { result: `handled ${kind}` },
        evidence: [{ type: "artifact" as const, description: `${kind} evidence` }],
      };
    },
  };
}

function makePack(id: string, roleIds: string[], handlerKinds: string[]): CapabilityPack {
  return {
    id,
    name: `${id} pack`,
    description: `Description for ${id}`,
    roles: roleIds.map((rid) => ({
      id: rid,
      name: rid,
      description: `Role ${rid}`,
      skills: [`${rid}_skill`],
    })),
    nodeHandlers: new Map(handlerKinds.map((k) => [k, makeHandler(k)])),
  };
}

describe("CapabilityRegistry", () => {
  it("should register and retrieve a pack", () => {
    const registry = new CapabilityRegistry();
    const pack = makePack("test", ["role1"], ["agent_task"]);
    registry.register(pack);
    expect(registry.get("test")).toBe(pack);
  });

  it("should return undefined for unknown pack", () => {
    const registry = new CapabilityRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("should unregister a pack", () => {
    const registry = new CapabilityRegistry();
    const pack = makePack("test", ["role1"], ["agent_task"]);
    registry.register(pack);
    registry.unregister("test");
    expect(registry.get("test")).toBeUndefined();
  });

  it("should return all registered packs", () => {
    const registry = new CapabilityRegistry();
    const pack1 = makePack("p1", ["r1"], ["agent_task"]);
    const pack2 = makePack("p2", ["r2"], ["team_task"]);
    registry.register(pack1);
    registry.register(pack2);
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContain(pack1);
    expect(all).toContain(pack2);
  });

  it("should find handler for a given kind", () => {
    const registry = new CapabilityRegistry();
    const pack = makePack("test", ["role1"], ["agent_task", "team_task"]);
    registry.register(pack);
    const handler = registry.findHandlerForKind("agent_task");
    expect(handler).toBeDefined();
    expect(handler!.kind).toBe("agent_task");
  });

  it("should return undefined when no handler matches kind", () => {
    const registry = new CapabilityRegistry();
    const pack = makePack("test", ["role1"], ["agent_task"]);
    registry.register(pack);
    expect(registry.findHandlerForKind("unknown_kind")).toBeUndefined();
  });

  it("should find handler across multiple packs", () => {
    const registry = new CapabilityRegistry();
    registry.register(makePack("p1", ["r1"], ["agent_task"]));
    registry.register(makePack("p2", ["r2"], ["synthesis_task"]));
    const handler = registry.findHandlerForKind("synthesis_task");
    expect(handler).toBeDefined();
    expect(handler!.kind).toBe("synthesis_task");
  });

  it("should get all roles from multiple packs", () => {
    const registry = new CapabilityRegistry();
    registry.register(makePack("p1", ["researcher", "analyst"], ["agent_task"]));
    registry.register(makePack("p2", ["implementer"], ["team_task"]));
    const roles = registry.getAllRoles();
    expect(roles).toHaveLength(3);
    expect(roles.map((r) => r.id)).toEqual(["researcher", "analyst", "implementer"]);
  });

  it("should return empty arrays when no packs registered", () => {
    const registry = new CapabilityRegistry();
    expect(registry.getAll()).toHaveLength(0);
    expect(registry.getAllRoles()).toHaveLength(0);
    expect(registry.findHandlerForKind("any")).toBeUndefined();
  });

  it("should execute a handler from registry", async () => {
    const registry = new CapabilityRegistry();
    registry.register(makePack("test", ["r1"], ["agent_task"]));
    const handler = registry.findHandlerForKind("agent_task");
    const result = await handler!.execute({
      nodeId: "n1",
      runId: "run1",
      teamId: "team1",
      kind: "agent_task",
      inputs: {},
      scratchpad: {},
    });
    expect(result.status).toBe("completed");
    expect(result.outputs.result).toBe("handled agent_task");
  });
});
