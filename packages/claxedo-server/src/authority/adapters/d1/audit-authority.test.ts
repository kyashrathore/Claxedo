import { describe, expect, test } from "vitest"
import { mcpAuditRecord } from "@claxedo/mcp"
import { MCP_SCOPES, type McpCredential } from "@claxedo/mcp/context"
import { safeMetadata } from "./audit-authority"

const runtimeCredential: McpCredential = {
  kind: "runtime",
  runtimeId: "rt_1",
  workspaceId: "ws_1",
  userId: "user_1",
  sessionId: "ses_parent",
  crossMachineWrites: false,
  readOnly: false,
}

const userCredential: McpCredential = {
  kind: "user",
  actorId: "actor_9",
  clientId: "cli",
  scopes: new Set(MCP_SCOPES),
  readOnly: false,
}

describe("the D1 audit metadata allowlist", () => {
  test("keeps every field an MCP write records for a runtime caller", () => {
    const record = mcpAuditRecord({ tool: "session_send", credential: runtimeCredential, sessionId: "ses_child" })
    expect(JSON.parse(safeMetadata(record) ?? "null")).toEqual({
      actor: "user_1",
      callerSessionId: "ses_parent",
      client: "runtime:rt_1",
      sessionId: "ses_child",
      tool: "session_send",
      workspaceId: "ws_1",
    })
  })

  test("keeps every field an MCP write records for a signed account caller", () => {
    const record = mcpAuditRecord({ tool: "workspace_create", credential: userCredential })
    expect(JSON.parse(safeMetadata(record) ?? "null")).toEqual({
      actor: "actor_9",
      client: "cli",
      tool: "workspace_create",
    })
  })

  test("still drops a key no allowlisted field names", () => {
    expect(safeMetadata({ tool: "x", prompt: "secret" })).toBe(JSON.stringify({ tool: "x" }))
  })
})
