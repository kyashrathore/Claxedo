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
