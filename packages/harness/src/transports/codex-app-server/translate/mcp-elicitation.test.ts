import { expect, test } from "bun:test"
import { codexMcpApproval } from "./mcp-elicitation"

const form = { serverName: "example-server", mode: "form", requestedSchema: { type: "object", properties: {} } }

test("message wording and an empty form never imply permission", () => {
  expect(codexMcpApproval({ ...form, message: "Allow Computer Use?", serverName: "cua_repl" })).toBeUndefined()
  expect(codexMcpApproval({ ...form, _meta: { codex_approval_kind: "browser_auth" } })).toBeUndefined()
})

test("scopes come only from the request and round-trip without a scope catalog", () => {
  const request = { ...form, serverName: "arbitrary-server", _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "future-scope"] } }
  const approval = codexMcpApproval(request)!
  expect(approval.options.map((option) => option.label)).toEqual(["Accept", "Decline", "Cancel", "Accept (session)", "Accept (future-scope)"])
  expect(approval.options.at(-1)?.response).toEqual({ action: "accept", content: {}, _meta: { persist: "future-scope" } })
  expect(codexMcpApproval({ ...form, _meta: { codex_approval_kind: "mcp_tool_call" } })?.options.map((option) => option.id)).toEqual(["accept", "decline", "cancel"])
})

test("single advertised scope is preserved and form fields are not discarded", () => {
  expect(codexMcpApproval({ ...form, _meta: { codex_approval_kind: "mcp_tool_call", persist: "always" } })?.options.at(-1)?.response)
    .toEqual({ action: "accept", content: {}, _meta: { persist: "always" } })
  expect(codexMcpApproval({ ...form, _meta: { codex_approval_kind: "mcp_tool_call" }, requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["first", "second"] } } } })).toBeUndefined()
})
