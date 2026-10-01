import type { AgentRuntimeEvent, AgentRuntimeEventOf } from "@claxedo/agent-runtime-contract"
import { runtimeDiagnostic, asText as text } from "@claxedo/agent-runtime-contract"
import type { CodexHandler, CodexHandlers } from "./frame"

type Severity = "debug" | "info" | "warn" | "error"

export function unmappedCodexAppServerEvent(event: { source: string; method?: string; payload: unknown }) {
  return [{
    type: "diagnostic",
    diagnostic: runtimeDiagnostic({
      code: "codex_app_server.unmapped_event",
      message: `${event.method ?? "unknown"}: Codex app-server method has no AgentRuntimeEvent mapping`,
      severity: "info",
      source: event.source,
      method: event.method,
      raw: event.payload,
    }),
  } satisfies AgentRuntimeEvent]
}

export function harnessNotice(input: Omit<AgentRuntimeEventOf<"harness-notice">, "type" | "severity"> & { severity?: Severity }) {
  return { type: "harness-notice", ...input, severity: input.severity ?? "info" } satisfies AgentRuntimeEvent
}

const warning: CodexHandler = ({ method, row }) => [harnessNotice({
  code: `codex_app_server.${method.replace("/", "_")}`,
  message: text(row.message) ?? "Codex warning",
  severity: "warn",
  details: row,
})]

export const noticeHandlers: CodexHandlers = {
  "mcpServer/startupStatus/updated": ({ row }) => [{
    type: "mcp-server-status",
    serverName: text(row.name) ?? "mcp",
    status: row.status === "ready" || row.status === "failed" || row.status === "cancelled" ? row.status : "starting",
    error: text(row.error) ?? null,
  }],
  "mcpServer/oauthLogin/completed": ({ row }) => [harnessNotice({
    code: row.success === true ? "codex_app_server.mcp_oauth_login_completed" : "codex_app_server.mcp_oauth_login_failed",
    message: row.success === true
      ? `MCP server ${text(row.name) ?? "unknown"} OAuth login completed`
      : text(row.error) ?? `MCP server ${text(row.name) ?? "unknown"} OAuth login failed`,
    severity: row.success === true ? "info" : "warn",
    details: row,
  })],
  warning,
  guardianWarning: warning,
  "model/verification": ({ row }) => [harnessNotice({
    code: "codex_app_server.model_verification",
    message: "Codex model verification updated",
    severity: "debug",
    details: row,
  })],
}
