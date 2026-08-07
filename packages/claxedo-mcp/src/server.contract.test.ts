import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

describe("published MCP tool contract", () => {
  test("keeps spawn_session registered with its public workspace selector", () => {
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8")

    expect(source).toContain('registerTool(\n    "spawn_session"')
    expect(source).toContain("workspace_id: z.string().optional()")
    expect(source).toContain("[claxedo-mcp] spawn_session initial prompt failed")
  })
})
