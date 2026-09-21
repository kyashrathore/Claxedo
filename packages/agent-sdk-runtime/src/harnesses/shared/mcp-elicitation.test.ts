import { describe, expect, test } from "bun:test"
import { mcpElicitationQuestion, mcpElicitationResponse } from "./mcp-elicitation"

describe("MCP elicitation questions", () => {
  test("keeps the server message and authorization URL in the projected question", () => {
    expect(mcpElicitationQuestion({
      serverName: "composio",
      mode: "url",
      message: "Connect Gmail",
      url: "https://example.test/connect",
    })).toMatchObject({
      question: expect.stringContaining("https://example.test/connect"),
      options: [{ label: "I've finished connecting" }],
      custom: false,
    })
  })

  test("maps answer and dismissal to the app-server response contract", () => {
    expect(mcpElicitationResponse({ mode: "url" }, "I've finished connecting"))
      .toEqual({ action: "accept" })
    expect(mcpElicitationResponse({ mode: "url" }, undefined))
      .toEqual({ action: "cancel" })
  })

  test("returns structured content for form elicitations and rejects non-objects", () => {
    expect(mcpElicitationResponse({ mode: "form" }, '{"account":"gmail"}'))
      .toEqual({ action: "accept", content: { account: "gmail" } })
    expect(() => mcpElicitationResponse({ mode: "form" }, "not-json"))
      .toThrow("must be a JSON object")
    expect(() => mcpElicitationResponse({ mode: "form" }, "[]"))
      .toThrow("must be a JSON object")
  })
})
