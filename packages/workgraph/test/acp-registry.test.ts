import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadRegistry, resolveEntry } from "../src/orchestrator/acp/acp-registry";
import type { AcpRegistryConfig } from "../src/orchestrator/acp/acp-registry";

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
          baseUrl: "http://localhost:9090",
          agent: "codex",
          token: "sk-test",
        },
        taskKinds: ["code_gen", "test", "docs"],
      },
    ],
    defaultEntryId: "build-codex",
    ...overrides,
  };
}

describe("loadRegistry", () => {
  let savedConfig: string | undefined;
  let savedPath: string | undefined;

  beforeEach(() => {
    savedConfig = process.env.ACP_REGISTRY_CONFIG;
    savedPath = process.env.ACP_REGISTRY_PATH;
    delete process.env.ACP_REGISTRY_CONFIG;
    delete process.env.ACP_REGISTRY_PATH;
  });

  afterEach(() => {
    if (savedConfig !== undefined) process.env.ACP_REGISTRY_CONFIG = savedConfig;
    else delete process.env.ACP_REGISTRY_CONFIG;
    if (savedPath !== undefined) process.env.ACP_REGISTRY_PATH = savedPath;
    else delete process.env.ACP_REGISTRY_PATH;
  });

  it("should return null when no env vars are set", () => {
    expect(loadRegistry()).toBeNull();
  });

  it("should parse ACP_REGISTRY_CONFIG inline JSON", () => {
    const config = makeRegistry();
    process.env.ACP_REGISTRY_CONFIG = JSON.stringify(config);

    const result = loadRegistry();
    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(2);
    expect(result!.entries[0].id).toBe("research-claude");
    expect((result!.entries[0].transport as any).agent).toBe("claude");
    expect(result!.defaultEntryId).toBe("build-codex");
  });

  it("should return null for invalid JSON in ACP_REGISTRY_CONFIG", () => {
    process.env.ACP_REGISTRY_CONFIG = "not valid json{";
    expect(loadRegistry()).toBeNull();
  });

  it("should return null for non-existent ACP_REGISTRY_PATH", () => {
    process.env.ACP_REGISTRY_PATH = "/tmp/does-not-exist-acp-config.json";
    expect(loadRegistry()).toBeNull();
  });
});

describe("resolveEntry", () => {
  it("should resolve entry by exact task kind match", () => {
    const registry = makeRegistry();

    const entry = resolveEntry(registry, "research");
    expect(entry).toBeDefined();
    expect(entry!.id).toBe("research-claude");
    expect((entry!.transport as any).agent).toBe("claude");
  });

  it("should resolve code_gen to codex entry", () => {
    const registry = makeRegistry();

    const entry = resolveEntry(registry, "code_gen");
    expect(entry).toBeDefined();
    expect(entry!.id).toBe("build-codex");
    expect((entry!.transport as any).agent).toBe("codex");
  });

  it("should resolve review to claude entry", () => {
    const registry = makeRegistry();

    const entry = resolveEntry(registry, "review");
    expect(entry).toBeDefined();
    expect(entry!.id).toBe("research-claude");
  });

  it("should fall back to defaultEntryId for unknown task kind", () => {
    const registry = makeRegistry();

    const entry = resolveEntry(registry, "unknown_kind");
    expect(entry).toBeDefined();
    expect(entry!.id).toBe("build-codex");
  });

  it("should return undefined when no match and no default", () => {
    const registry = makeRegistry({ defaultEntryId: undefined });

    const entry = resolveEntry(registry, "unknown_kind");
    expect(entry).toBeUndefined();
  });

  it("should return undefined when entries list is empty", () => {
    const registry = makeRegistry({ entries: [] });

    const entry = resolveEntry(registry, "research");
    expect(entry).toBeUndefined();
  });

  it("should work with stdio transport entries", () => {
    const registry: AcpRegistryConfig = {
      entries: [
        {
          id: "local-agent",
          name: "Local Agent",
          transport: {
            mode: "stdio",
            command: "npx",
            args: ["-y", "@example/agent"],
          },
          taskKinds: ["research"],
        },
      ],
    };

    const entry = resolveEntry(registry, "research");
    expect(entry).toBeDefined();
    expect(entry!.transport.mode).toBe("stdio");
  });
});
