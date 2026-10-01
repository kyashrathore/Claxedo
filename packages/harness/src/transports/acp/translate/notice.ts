import type { AgentRuntimeEventOf, RuntimeNoticeSeverity } from "@claxedo/agent-runtime-contract"
import type { SessionUpdate } from "./types"

type Notice = Extract<SessionUpdate, { sessionUpdate: "notice" }>

function acpNoticeSeverity(severity: Notice["severity"]): RuntimeNoticeSeverity {
  if (severity === "warning") return "warn"
  return severity === "error" ? "error" : "info"
}

export function noticeEvent(update: Notice): AgentRuntimeEventOf<"harness-notice"> {
  const description = update.description?.trim()
  return {
    type: "harness-notice",
    code: "acp.notice",
    message: description ? `${update.title.replace(/\.$/, "")}. ${description}` : update.title,
    severity: acpNoticeSeverity(update.severity),
    details: { severity: update.severity, title: update.title, ...(description ? { description } : {}) },
  }
}
