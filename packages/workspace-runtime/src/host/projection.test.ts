import { describe, expect, test } from "bun:test"
import { pluginProjectionFor } from "./projection"
import { filterMcpServers } from "@claxedo/harness/capabilities"

const root = { pluginInstanceId: "pi_review", root: "/runtime/generations/g7/plugins/review", dataRoot: "/runtime/data/pi_review", skillNames: ["review"] }
const harnessLaunch = { claude: { generation: "generation-7-abc", execution: { mode: "default" }, mcpServers: [], notApplied: [], pluginRoots: [root] } }

describe("pluginProjectionFor", () => {
  test("plugin HTTP provenance survives snapshot projection and the remote filter", () => {
    const projection = pluginProjectionFor({ id: "remote", access: "connection" }, {
      generation: "g", harnessLaunch: {}, mcp: {
        plugin: { name: "plugin", source: "plugin", transport: "remote", url: "https://plugin.example/mcp", headers: { Authorization: "plugin-secret" } },
        user: { name: "user", source: "user", transport: "remote", url: "https://user.example/mcp", headers: {} },
      },
    })
    const filtered = filterMcpServers({ servers: projection.mcpServers, locality: "remote", mcpCapabilities: { http: true } })
    expect(filtered.servers.map((server) => server.name)).toEqual(["user"])
    expect(filtered.notApplied).toEqual([{ item: "plugin", reason: "remote-harness" }])
  })

  test("the projection reports unsupported ACP cwd without dropping representable servers", () => {
    const projection = pluginProjectionFor({ id: "custom", access: "connection" }, {
      generation: "g", harnessLaunch: {}, mcp: {
        local: { name: "local", source: "plugin", transport: "stdio", command: "/plugins/server", cwd: "/plugins/data", args: [], env: {} },
        supported: { name: "supported", source: "plugin", transport: "stdio", command: "/plugins/other", args: [], env: {} },
      },
    })
    expect(projection.mcpServers.map((server) => server.name)).toEqual(["supported"])
    expect(projection.notApplied).toEqual([{ item: "local", reason: "unsupported-by-harness" }])
  })

  test("OpenCode launches a local server in its declared working directory", () => {
    const projection = pluginProjectionFor({ id: "opencode", access: "native" }, { generation: "g", harnessLaunch: {}, mcp: {
      cwd: { name: "cwd", source: "user", transport: "stdio", command: "/server", cwd: "/data", args: [], env: {} },
    } })
    expect(projection.mcpServers).toEqual([{ kind: "stdio", name: "cwd", origin: "configured", command: "/server", cwd: "/data", args: [], env: {} }])
    expect(projection.notApplied).toEqual([])
  })

  test("claude reports unrepresentable entries without blocking launch", () => {
    const projection = pluginProjectionFor({ id: "claude", access: "native" }, { generation: "g", harnessLaunch: {}, mcp: {
      cwd: { name: "cwd", source: "user", transport: "stdio", command: "/server", cwd: "/data", args: [], env: {} },
      http: { name: "http", source: "user", transport: "remote", url: "https://mcp.example", headers: {} },
    } })
    expect(projection.mcpServers.map((server) => server.name)).toEqual(["http"])
    expect(projection.notApplied).toContainEqual({ item: "cwd", reason: "unsupported-by-harness" })
  })

  test("pi carries stdio and HTTP servers and reports a server name Pi rejects without blocking launch", () => {
    const projection = pluginProjectionFor({ id: "pi", access: "native" }, { generation: "g", harnessLaunch: {}, mcp: {
      cwd: { name: "cwd", source: "user", transport: "stdio", command: "/server", cwd: "/data", args: [], env: {} },
      http: { name: "http", source: "user", transport: "remote", url: "https://mcp.example", headers: {} },
      dotted: { name: "team.docs", source: "user", transport: "remote", url: "https://docs.example", headers: {} },
    } })
    expect(projection.mcpServers.map((server) => server.name)).toEqual(["cwd", "http"])
    expect(projection.notApplied).toEqual([{ item: "team.docs", reason: "unsupported-by-harness" }])
  })
  test("carries the materializer's generation and plugin identities into the start projection", () => {
    expect(pluginProjectionFor({ id: "claude", access: "native" }, { generation: "runtime-config:3", mcp: {}, harnessLaunch })).toEqual({
      generation: "runtime-config:3/plugins:generation-7-abc",
      pluginSelection: { mode: "default" },
      mcpServers: [],
      pluginRoots: [root],
      notApplied: [],
    })
  })

  test("a harness without a launch row starts on the runtime generation alone", () => {
    expect(pluginProjectionFor({ id: "codex", access: "native" }, { generation: "runtime-config:3", mcp: {}, harnessLaunch }))
      .toMatchObject({ generation: "runtime-config:3", pluginRoots: [] })
  })

  test("a launch row with bare paths is refused rather than rebuilt into identities", () => {
    expect(() => pluginProjectionFor({ id: "claude", access: "native" }, {
      generation: "runtime-config:3", mcp: {}, harnessLaunch: { claude: { generation: "g", execution: { mode: "default" }, mcpServers: [], notApplied: [], pluginRoots: [root.root] } },
    })).toThrow("without pluginInstanceId, root, dataRoot and skillNames")
    expect(() => pluginProjectionFor({ id: "claude", access: "native" }, {
      generation: "runtime-config:3", mcp: {}, harnessLaunch: { claude: { pluginRoots: [root] } },
    })).toThrow("must name its generation")
  })

  test("rejects missing or forged MCP provenance", () => {
    for (const source of [undefined, "configured", "unexpected", ["plugin"], ["managed"], { toString: () => "plugin" }]) {
      expect(() => pluginProjectionFor({ id: "remote", access: "connection" }, {
        generation: "g", harnessLaunch: {}, mcp: { bad: { name: "bad", transport: "remote", source, url: "https://bad.example", headers: {} } },
      })).toThrow("Invalid snapshot MCP source")
    }
    expect(() => pluginProjectionFor({ id: "opencode", access: "native" }, {
      generation: "g", mcp: {}, harnessLaunch: { opencode: { generation: "p", execution: { mode: "default" }, pluginRoots: [], mcpServers: [{ name: "bad", kind: "http", origin: "configured", url: "https://bad.example" }] } },
    })).toThrow("non-plugin MCP origin")
  })

  test("OpenCode carries not-applied results and receives only its own plugin projection", () => {
    const projection = pluginProjectionFor({ id: "opencode", access: "native" }, {
      generation: "g", mcp: { acp: { name: "acp-only", source: "plugin", transport: "remote", url: "https://acp.example", headers: {} } },
      harnessLaunch: { opencode: { generation: "p", execution: { mode: "default" }, pluginRoots: [], notApplied: [{ item: "local", reason: "unsupported-by-harness" }], mcpServers: [
        { name: "http", kind: "http", origin: "plugin", url: "https://plugin.example" },
      ] } },
    })
    expect(projection.mcpServers.map((server) => server.name)).toEqual(["http"])
    expect(projection.notApplied).toEqual([{ item: "local", reason: "unsupported-by-harness" }])
  })
})
