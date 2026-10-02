import type { AgentEventEnvelope, AgentRuntimeEventOf } from "@claxedo/agent-runtime-contract"
import { runtimeDiagnostic, withDir } from "../presentation-events"
import type { CompatContext } from "./context"

type HarnessDiagnosticEvent = AgentRuntimeEventOf<"auth-status" | "rate-limit" | "mcp-server-status" | "diagnostic">

export function projectHarnessDiagnostic(ctx: CompatContext, chunk: HarnessDiagnosticEvent): AgentEventEnvelope {
  switch (chunk.type) {
    case "auth-status":
      return withDir(ctx.directory, runtimeDiagnostic({
        sessionID: ctx.sessionId,
        harness: chunk.harness,
        threadId: chunk.threadId,
        code: "runtime.auth_status",
        message: `Auth status: ${chunk.status}`,
        severity: chunk.status === "unauthenticated" ? "warn" : "info",
        auth: {
          status: chunk.status,
          authMode: chunk.authMode,
          planType: chunk.planType,
          metadata: chunk.metadata,
        },
        raw: chunk.raw,
      }))
    case "rate-limit":
      return withDir(ctx.directory, runtimeDiagnostic({
        sessionID: ctx.sessionId,
        harness: chunk.harness,
        threadId: chunk.threadId,
        code: "runtime.rate_limit",
        message: chunk.status === "limited" ? "Rate limit reached" : "Rate limit updated",
        severity: chunk.status === "limited" ? "warn" : "info",
        rateLimit: {
          status: chunk.status,
          usedPercent: chunk.usedPercent,
          resetsAt: chunk.resetsAt,
          windowDurationMins: chunk.windowDurationMins,
          limitId: chunk.limitId,
          limitName: chunk.limitName,
          reason: chunk.reason,
          metadata: chunk.metadata,
        },
        raw: chunk.raw,
      }))
    case "mcp-server-status":
      return withDir(ctx.directory, runtimeDiagnostic({
        sessionID: ctx.sessionId,
        harness: chunk.harness,
        threadId: chunk.threadId,
        code: "runtime.mcp_server_status",
        message: chunk.error ?? `MCP server ${chunk.serverName} is ${chunk.status}`,
        severity: chunk.status === "failed" || chunk.status === "cancelled" ? "warn" : "info",
        mcp: {
          serverName: chunk.serverName,
          status: chunk.status,
          error: chunk.error,
        },
        raw: chunk.raw,
      }))
    case "diagnostic":
      return withDir(ctx.directory, runtimeDiagnostic({
        sessionID: ctx.sessionId,
        harness: chunk.harness,
        threadId: chunk.threadId,
        code: chunk.diagnostic.code,
        message: chunk.diagnostic.message,
        severity: chunk.diagnostic.severity,
        diagnostic: chunk.diagnostic,
        raw: chunk.raw,
      }))
  }
}
