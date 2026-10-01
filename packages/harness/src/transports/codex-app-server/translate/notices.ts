import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { runtimeDiagnostic, asText as text } from "@claxedo/agent-runtime-contract"
import type { CodexHandler, CodexHandlers } from "./frame"

type Severity = "debug" | "info" | "warn" | "error"

export function diagnosticForEvent(input: {
  code: string
  message: string
  severity?: Severity
  event: { source: string; method?: string; payload: unknown }
}) {
  return {
    type: "diagnostic",
    diagnostic: runtimeDiagnostic({
      code: input.code,
      message: input.message,
      severity: input.severity,
      source: input.event.source,
      method: input.event.method,
      raw: input.event.payload,
    }),
  } satisfies AgentRuntimeEvent
}

export function unmappedCodexAppServerEvent(event: { source: string; method?: string; payload: unknown }) {
  const method = event.method ?? "unknown"
  return [diagnosticForEvent({
    code: "codex_app_server.unmapped_event",
    message: `${method}: Codex app-server method has no AgentRuntimeEvent mapping`,
    severity: "info",
    event,
  })]
}

export function harnessNotice(input: {
  code: string
  message: string
  severity?: Severity
  details?: unknown
}) {
  return {
    type: "harness-notice",
    code: input.code,
    message: input.message,
    severity: input.severity ?? "info",
    ...(input.details !== undefined ? { details: input.details } : {}),
  } satisfies AgentRuntimeEvent
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
  configWarning: ({ row }) => [harnessNotice({
    code: "codex_app_server.config_warning",
    message: text(row.summary) ?? "Codex config warning",
    severity: "warn",
    details: row,
  })],
  deprecationNotice: ({ row }) => [harnessNotice({
    code: "codex_app_server.deprecation_notice",
    message: text(row.summary) ?? "Codex deprecation notice",
    severity: "info",
    details: row,
  })],
  "model/verification": ({ row }) => [harnessNotice({
    code: "codex_app_server.model_verification",
    message: "Codex model verification updated",
    severity: "debug",
    details: row,
  })],
  "windows/worldWritableWarning": ({ row }) => [harnessNotice({
    code: "codex_app_server.windows_world_writable_warning",
    message: text(row.message) ?? "Windows world-writable path warning",
    severity: "warn",
    details: row,
  })],
  "windowsSandbox/setupCompleted": ({ row, event }) => row.success === false
    ? [
      { type: "session-status", status: "error" },
      diagnosticForEvent({ code: "codex_app_server.sandbox_setup_failed", message: text(row.error) ?? "Sandbox setup failed", severity: "warn", event }),
    ]
    : [],
}
