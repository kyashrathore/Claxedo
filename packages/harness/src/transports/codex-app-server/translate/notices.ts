import type { AgentRuntimeEvent, AgentRuntimeEventOf } from "@claxedo/agent-runtime-contract"
import { runtimeDiagnostic, asText as text } from "@claxedo/agent-runtime-contract"
import type { CodexHandler, CodexHandlers } from "./frame"

type Severity = "debug" | "info" | "warn" | "error"

export function diagnosticForEvent(input: {
  code: string
  message: string
  severity?: Severity
  event: { source: string; method?: string; payload: unknown }
}) {
  const { event, ...diagnostic } = input
  return {
    type: "diagnostic",
    diagnostic: runtimeDiagnostic({
      ...diagnostic,
      source: event.source,
      method: event.method,
      raw: event.payload,
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

export function harnessNotice(input: Omit<AgentRuntimeEventOf<"harness-notice">, "type" | "severity"> & { severity?: Severity }) {
  return { type: "harness-notice", ...input, severity: input.severity ?? "info" } satisfies AgentRuntimeEvent
}

const warning: CodexHandler = ({ method, row }) => [harnessNotice({
  code: `codex_app_server.${method.replace("/", "_")}`,
  message: text(row.message) ?? "Codex warning",
  severity: "warn",
  details: row,
})]

function protocolNotice(code: string, message: string, severity: Severity, field?: string): CodexHandler {
  return ({ row }) => [harnessNotice({ code: `codex_app_server.${code}`, message: field ? text(row[field]) ?? message : message, severity, details: row })]
}

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
  configWarning: protocolNotice("config_warning", "Codex config warning", "warn", "summary"),
  deprecationNotice: protocolNotice("deprecation_notice", "Codex deprecation notice", "info", "summary"),
  "model/verification": protocolNotice("model_verification", "Codex model verification updated", "debug"),
  "windows/worldWritableWarning": protocolNotice("windows_world_writable_warning", "Windows world-writable path warning", "warn", "message"),
  "windowsSandbox/setupCompleted": ({ row, event }) => row.success === false
    ? [
      { type: "session-status", status: "error" },
      diagnosticForEvent({ code: "codex_app_server.sandbox_setup_failed", message: text(row.error) ?? "Sandbox setup failed", severity: "warn", event }),
    ]
    : [],
}
