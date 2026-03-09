import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AcpBackend } from "../src/orchestrator/acp/acp-backend";
import { createBackend, SubprocessBackend } from "../src/orchestrator/backends";
import type { AcpRegistryConfig } from "../src/orchestrator/acp/acp-registry";
import type { DecomposedTask } from "../src/orchestrator/types";
import type { AgentRecord } from "../src/routes/agent";

function makeTask(overrides?: Partial<DecomposedTask>): DecomposedTask {
  return {
    id: "task1",
    title: "Test Task",
    kind: "research",
    role: "developer",
    prompt: "Do research",
    depends_on: [],
    ...overrides,
  };
}

function makeRegistry(overrides?: Partial<AcpRegistryConfig>): AcpRegistryConfig {
  return {
    entries: [
      {
        id: "research-claude",
        name: "Claude for Research",
        transport: {
          mode: "http",
          baseUrl: "http://localhost:9090",
          agent: "claude",
        },
        taskKinds: ["research", "review"],
      },
      {
        id: "build-codex",
        name: "Codex for Building",
        transport: {
          mode: "http",
          baseUrl: "http://localhost:9091",
          agent: "codex",
        },
        taskKinds: ["code_gen", "test"],
      },
    ],
    defaultEntryId: "build-codex",
    ...overrides,
  };
}

describe("AcpBackend", () => {
  it("should throw when no entry matches the task kind", async () => {
    const backend = new AcpBackend({
      entries: [],
    });

    await expect(
      backend.launch(makeTask({ kind: "unknown" }), "run_1", "node_1"),
    ).rejects.toThrow('No ACP entry configured for task kind "unknown"');
  });

  it("should be an instance of AcpBackend", () => {
    const backend = new AcpBackend(makeRegistry());
    expect(backend).toBeInstanceOf(AcpBackend);
  });
});

describe("createBackend with ACP registry", () => {
  let savedConfig: string | undefined;
  let savedServerUrl: string | undefined;

  beforeEach(() => {
    savedConfig = process.env.ACP_REGISTRY_CONFIG;
    savedServerUrl = process.env.OPENCODE_SERVER_URL;
    delete process.env.ACP_REGISTRY_CONFIG;
    delete process.env.ACP_REGISTRY_PATH;
    delete process.env.OPENCODE_SERVER_URL;
  });

  afterEach(() => {
    if (savedConfig !== undefined) process.env.ACP_REGISTRY_CONFIG = savedConfig;
    else delete process.env.ACP_REGISTRY_CONFIG;
    if (savedServerUrl !== undefined) process.env.OPENCODE_SERVER_URL = savedServerUrl;
    else delete process.env.OPENCODE_SERVER_URL;
  });

  it("should return AcpBackend when ACP_REGISTRY_CONFIG is set", () => {
    process.env.ACP_REGISTRY_CONFIG = JSON.stringify(makeRegistry());

    const backend = createBackend(
      async () => ({} as AgentRecord),
      async () => ({} as AgentRecord),
    );

    expect(backend).toBeInstanceOf(AcpBackend);
  });

  it("should fall back to SubprocessBackend when no ACP config", () => {
    const backend = createBackend(
      async () => ({} as AgentRecord),
      async () => ({} as AgentRecord),
    );

    expect(backend).toBeInstanceOf(SubprocessBackend);
  });

  it("should fall back when ACP config has empty entries array", () => {
    process.env.ACP_REGISTRY_CONFIG = JSON.stringify({ entries: [] });

    const backend = createBackend(
      async () => ({} as AgentRecord),
      async () => ({} as AgentRecord),
    );

    expect(backend).toBeInstanceOf(SubprocessBackend);
  });

  it("should prefer ACP over SessionBackend when both configured", () => {
    process.env.ACP_REGISTRY_CONFIG = JSON.stringify(makeRegistry());
    process.env.OPENCODE_SERVER_URL = "http://localhost:3000";

    const backend = createBackend(
      async () => ({} as AgentRecord),
      async () => ({} as AgentRecord),
    );

    expect(backend).toBeInstanceOf(AcpBackend);
  });
});
