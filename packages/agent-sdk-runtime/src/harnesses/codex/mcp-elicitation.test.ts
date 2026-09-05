import { describe, expect, test } from "bun:test"
import { codexMcpElicitationQuestion, codexMcpElicitationResponse } from "./driver"

describe("Codex MCP elicitation", () => {
  test("keeps the server message and authorization URL in the projected question", () => {
    expect(codexMcpElicitationQuestion({
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
    expect(codexMcpElicitationResponse({ mode: "url" }, "I've finished connecting"))
      .toEqual({ action: "accept" })
    expect(codexMcpElicitationResponse({ mode: "url" }, undefined))
      .toEqual({ action: "cancel" })
  })

  test("projects Codex's empty-form tool approval as one click and accepts the route's empty answer", () => {
    const params = {
      serverName: "composio",
      mode: "form",
      message: 'Allow the composio MCP server to run tool "COMPOSIO_MANAGE_CONNECTIONS"?',
      requestedSchema: { type: "object", properties: {} },
    }

    expect(codexMcpElicitationQuestion(params)).toMatchObject({
      header: "Allow composio",
      question: expect.stringContaining("COMPOSIO_MANAGE_CONNECTIONS"),
      options: [{ label: "Allow once" }],
      custom: false,
    })
    expect(codexMcpElicitationResponse(params, ""))
      .toEqual({ action: "accept", content: {} })
    expect(codexMcpElicitationResponse(params, undefined))
      .toEqual({ action: "cancel" })
  })

  test("returns structured content for form elicitations and rejects non-objects", () => {
    expect(codexMcpElicitationResponse({ mode: "form" }, '{"account":"gmail"}'))
      .toEqual({ action: "accept", content: { account: "gmail" } })
    expect(() => codexMcpElicitationResponse({ mode: "form" }, "not-json"))
      .toThrow("must be a JSON object")
    expect(() => codexMcpElicitationResponse({ mode: "form" }, "[]"))
      .toThrow("must be a JSON object")
  })
})
