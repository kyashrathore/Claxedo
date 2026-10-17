import { describe, expect, test } from "bun:test"
import type { AgentToolPart } from "./content"
import { mcpAppCsp, mcpAppResourceUri, mcpToolVisibleTo, toolMcpFacts } from "./mcp-app"
import { toolPartHeader } from "./tool-header"

const facts = {
  server: "weather",
  tool: "forecast",
  resultMeta: { trace: "t" },
  structuredContent: { days: [1, 2, 3] },
  app: { resourceUri: "ui://weather/forecast", csp: { connectDomains: ["https://api.weather.test"] }, prefersBorder: true },
}

describe("toolMcpFacts", () => {
  test("reads the server, tool, result and app reference", () => {
    expect(toolMcpFacts({ mcp: facts })).toEqual(facts)
  })

  test("is absent without a server or tool", () => {
    expect(toolMcpFacts({ mcp: { tool: "forecast" } })).toBeUndefined()
    expect(toolMcpFacts(undefined)).toBeUndefined()
  })
})

describe("mcpAppCsp", () => {
  test("keeps only scheme-qualified origins, at most 32", () => {
    const many = Array.from({ length: 40 }, (_, index) => `https://h${index}.test`)
    expect(mcpAppCsp({ connectDomains: ["*.evil.test", "https://ok.test/", "https://ok.test/path", "javascript:alert(1)", ...many] })).toEqual({
      connectDomains: ["https://ok.test", ...many.slice(0, 31)],
    })
  })

  test("is absent when nothing usable is declared", () => {
    expect(mcpAppCsp({ resourceDomains: ["*", "https://*.cdn.test"] })).toBeUndefined()
  })
})

describe("mcpAppResourceUri", () => {
  test("reads the ui resource and the deprecated key, and refuses other schemes", () => {
    expect(mcpAppResourceUri({ ui: { resourceUri: "ui://a/b" } })).toBe("ui://a/b")
    expect(mcpAppResourceUri({ "ui/resourceUri": "ui://a/c" })).toBe("ui://a/c")
    expect(mcpAppResourceUri({ ui: { resourceUri: "https://a/b" } })).toBeUndefined()
  })
})

describe("toolPartHeader with MCP facts", () => {
  test("keeps the server, tool and app reference and drops the result", () => {
    const part: AgentToolPart = {
      id: "p", sessionID: "s", messageID: "m", type: "tool", callID: "c", tool: "mcp__weather__forecast",
      state: { status: "completed", input: { city: "Oslo" }, output: "big", title: "forecast", metadata: { mcp: facts, other: 1 }, time: { start: 1, end: 2 } },
    }
    const header = toolPartHeader(part)
    expect(header.headerOnly).toBe(true)
    expect(header.state.status === "completed" && header.state.metadata).toEqual({ mcp: { server: "weather", tool: "forecast", app: facts.app } })
  })
})

describe("mcpToolVisibleTo", () => {
  test("a tool without a visibility list is visible to the model and to apps", () => {
    expect(mcpToolVisibleTo({ ui: { resourceUri: "ui://a/b" } }, "model")).toBe(true)
    expect(mcpToolVisibleTo(undefined, "app")).toBe(true)
  })

  test("a declared list hides the tool from an audience it does not name", () => {
    expect(mcpToolVisibleTo({ ui: { visibility: ["app"] } }, "model")).toBe(false)
    expect(mcpToolVisibleTo({ ui: { visibility: ["app"] } }, "app")).toBe(true)
  })
})
