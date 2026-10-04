import { isRecord } from "./values"

export type TranscriptNoticeSeverity = "info" | "warn" | "error"

export type TranscriptCompaction =
  | { status: "running" }
  | { status: "completed" }
  | { status: "failed"; error: string }

export type TranscriptNotice =
  | { kind: "harness"; code: string; message: string; severity: TranscriptNoticeSeverity }
  | { kind: "agent-message"; sender: string; senderName?: string; message: string; senderTaskId?: string; sourceSessionId?: string }
  | ({ kind: "compaction" } & TranscriptCompaction)
  | { kind: "conversation-reset"; trigger: string }

const SEVERITIES: ReadonlySet<unknown> = new Set<TranscriptNoticeSeverity>(["info", "warn", "error"])

function isCompaction(value: Record<string, unknown>): boolean {
  if (value.status === "running" || value.status === "completed") return true
  return value.status === "failed" && typeof value.error === "string"
}

export function isTranscriptNotice(value: unknown): value is TranscriptNotice {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case "harness":
      return typeof value.code === "string" && typeof value.message === "string" && SEVERITIES.has(value.severity)
    case "agent-message":
      return typeof value.sender === "string" && typeof value.message === "string"
        && (value.senderName === undefined || typeof value.senderName === "string")
        && (value.senderTaskId === undefined || typeof value.senderTaskId === "string")
        && (value.sourceSessionId === undefined || typeof value.sourceSessionId === "string")
    case "compaction":
      return isCompaction(value)
    case "conversation-reset":
      return typeof value.trigger === "string"
    default:
      return false
  }
}
