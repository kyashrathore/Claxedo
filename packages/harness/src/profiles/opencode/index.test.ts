import { expect, test } from "bun:test"
import { openCodeLaunchDocument } from "./index"

test("OpenCode profile keeps the session-scoped first-party MCP URL and projected skill roots", () => {
  const document = openCodeLaunchDocument({ generation: "g1", notApplied: [], mcpServers: [],
    pluginRoots: [{ pluginInstanceId: "plugin", root: "/tmp/plugin-skills", dataRoot: "/tmp/plugin-data" }] },
  { name: "claxedo", kind: "http", url: "http://127.0.0.1:9000/mcp?session=s1",
    headers: { authorization: "Bearer session-s1" } })
  expect(document.skills).toEqual(["/tmp/plugin-skills/skills"])
  expect(document.mcp.claxedo).toEqual({ type: "remote", url: "http://127.0.0.1:9000/mcp?session=s1",
    headers: { authorization: "Bearer session-s1" } })
})
