import { describe, it, expect } from "bun:test";
import { SubprocessBackend, createBackend } from "../src/orchestrator/backends";
import type { DecomposedTask } from "../src/orchestrator/types";
import type { AgentRecord } from "../src/routes/agent";

function makeTask(overrides?: Partial<DecomposedTask>): DecomposedTask {
  return {
    id: "task1",
    title: "Test Task",
    kind: "code_gen",
    team: "t1",
    prompt: "Do something",
    depends_on: [],
    ...overrides,
  };
}

describe("SubprocessBackend", () => {
  it("should launch a task and return a handle", async () => {
    const mockAgent: Partial<AgentRecord> = {
      id: "agent_1",
      status: "completed",
      exit_code: 0,
      output_chunks: ["Task completed successfully"],
      stderr_chunks: [],
    };

    const spawnFn = async (prompt: string, runId: string, nodeId: string) => {
      expect(prompt).toBe("Do something");
      expect(runId).toBe("run_1");
      expect(nodeId).toBe("node_1");
      return mockAgent as AgentRecord;
    };

    const waitFn = async (agentId: string) => {
      expect(agentId).toBe("agent_1");
      return mockAgent as AgentRecord;
    };

    const backend = new SubprocessBackend(spawnFn, waitFn);
    const handle = await backend.launch(makeTask(), "run_1", "node_1");

    expect(handle.id).toBe("agent_1");

    const result = await handle.await();
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Task completed successfully");
  });

  it("should return failed status when agent fails", async () => {
    const mockAgent: Partial<AgentRecord> = {
      id: "agent_2",
      status: "failed",
      exit_code: 1,
      output_chunks: ["partial output"],
      stderr_chunks: ["Error: something broke"],
    };

    const backend = new SubprocessBackend(
      async () => mockAgent as AgentRecord,
      async () => mockAgent as AgentRecord,
    );

    const handle = await backend.launch(makeTask(), "run_1", "node_1");
    const result = await handle.await();

    expect(result.status).toBe("failed");
    expect(result.error).toContain("something broke");
  });

  it("should call kill function on cancel", async () => {
    let killed = false;

    const mockAgent: Partial<AgentRecord> = {
      id: "agent_3",
      status: "running",
    };

    const backend = new SubprocessBackend(
      async () => mockAgent as AgentRecord,
      async () => new Promise(() => {}), // never resolves
      (agentId) => {
        killed = true;
        expect(agentId).toBe("agent_3");
      },
    );

    const handle = await backend.launch(makeTask(), "run_1", "node_1");
    handle.cancel();

    expect(killed).toBe(true);
  });

  it("should handle spawn errors gracefully", async () => {
    const backend = new SubprocessBackend(
      async () => {
        throw new Error("Spawn failed");
      },
      async () => ({} as AgentRecord),
    );

    await expect(backend.launch(makeTask(), "run_1", "node_1")).rejects.toThrow("Spawn failed");
  });

  it("should handle wait errors gracefully", async () => {
    const mockAgent: Partial<AgentRecord> = {
      id: "agent_4",
      status: "running",
    };

    const backend = new SubprocessBackend(
      async () => mockAgent as AgentRecord,
      async () => {
        throw new Error("Wait failed");
      },
    );

    const handle = await backend.launch(makeTask(), "run_1", "node_1");
    const result = await handle.await();

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Wait failed");
  });
});

describe("createBackend", () => {
  it("should create SubprocessBackend when OPENCODE_SERVER_URL is not set", () => {
    // Save and clear env var
    const saved = process.env.OPENCODE_SERVER_URL;
    delete process.env.OPENCODE_SERVER_URL;

    const backend = createBackend(
      async () => ({} as AgentRecord),
      async () => ({} as AgentRecord),
    );

    expect(backend).toBeInstanceOf(SubprocessBackend);

    // Restore
    if (saved) process.env.OPENCODE_SERVER_URL = saved;
  });
});
