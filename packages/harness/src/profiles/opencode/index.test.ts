import { expect, test } from "bun:test"
import { openCodeLaunchDocument } from "./index"

test("OpenCode profile keeps the directory MCP catalog and projected skill roots", () => {
  const projection = { generation: "g1", notApplied: [], mcpServers: [
    { origin: "configured", name: "shared", kind: "http", url: "http://127.0.0.1:9000/mcp" },
  ], pluginRoots: [{ pluginInstanceId: "plugin", root: "/tmp/plugin-skills", skillNames: ["review"], dataRoot: "/tmp/plugin-data" }] } as const
  const document = openCodeLaunchDocument(projection, projection.mcpServers)
  expect(document.skills).toEqual(["/tmp/plugin-skills/skills/review"])
  expect(document.mcp.shared).toEqual({ type: "remote", url: "http://127.0.0.1:9000/mcp" })
  expect(document.mcp.claxedo).toBeUndefined()
})

test("OpenCode profile launches a local MCP server in its declared working directory", () => {
  const projection = { generation: "g1", notApplied: [], pluginRoots: [], mcpServers: [
    { origin: "plugin", name: "local", kind: "stdio", command: "/plugin/server", args: ["--data"], env: { MODE: "x" }, cwd: "/plugin/work" },
  ] } as const
  expect(openCodeLaunchDocument(projection, projection.mcpServers).mcp.local).toEqual({
    type: "local", command: ["/plugin/server", "--data"], environment: { MODE: "x" }, cwd: "/plugin/work",
  })
})
