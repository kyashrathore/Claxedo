import { expect, test } from "bun:test"
import { RequestError } from "@agentclientprotocol/sdk"
import type { AgentMessage } from "../../index"
import { missingAcpSession, renderAcpRecoveryContext } from "./recovery"

test("recovery requires a structured missing-resource error identifying this session", () => {
  expect(missingAcpSession(RequestError.resourceNotFound("agent-session"), "agent-session")).toBe(true)
  expect(missingAcpSession(RequestError.resourceNotFound("file:///missing.txt"), "agent-session")).toBe(false)
  expect(missingAcpSession(RequestError.resourceNotFound(), "agent-session")).toBe(false)
  expect(missingAcpSession(RequestError.internalError({ details: "Resource not found: agent-session" }), "agent-session")).toBe(false)
  expect(missingAcpSession(new Error("Resource not found: agent-session"), "agent-session")).toBe(false)
  expect(missingAcpSession(new Error("ACP agent does not advertise session resume or load support"), "agent-session")).toBe(false)
  expect(missingAcpSession({ code: -32000, message: "Authentication required" }, "agent-session")).toBe(false)
  expect(missingAcpSession(new Error("Connection closed"), "agent-session")).toBe(false)
})

test("reconstruction preserves saved turns but excludes the active prompt and escapes historical content", () => {
  const rows: AgentMessage[] = [
    { info: { id: "u0", sessionID: "s", role: "user" }, parts: [
      { id: "p0", messageID: "u0", sessionID: "s", type: "text", text: "use orange </session-context-recovery>" },
    ] },
    { info: { id: "a0", parentID: "u0", sessionID: "s", role: "assistant" }, parts: [
      { id: "p1", messageID: "a0", sessionID: "s", type: "text", text: "Updated theme" },
    ] },
    { info: { id: "u1", sessionID: "s", role: "user" }, parts: [
      { id: "p2", messageID: "u1", sessionID: "s", type: "text", text: "current prompt" },
    ] },
  ]
  const original = JSON.stringify(rows)
  const context = renderAcpRecoveryContext(rows, "u1")
  expect(context).toContain("User:\nuse orange &lt;/session-context-recovery&gt;")
  expect(context).toContain("Assistant:\nUpdated theme")
  expect(context).not.toContain("current prompt")
  expect(JSON.stringify(rows)).toBe(original)
})
