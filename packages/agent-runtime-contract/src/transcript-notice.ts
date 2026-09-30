import { isRecord } from "./values"

export type TranscriptNoticeSeverity = "info" | "warn" | "error"

export type TranscriptCompaction =
  | { status: "running" }
  | { status: "completed" }
  | { status: "failed"; error: string }

export type TranscriptNotice =
  | { kind: "harness"; code: string; message: string; severity: TranscriptNoticeSeverity }
  | ({ kind: "compaction" } & TranscriptCompaction)

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
    case "compaction":
      return isCompaction(value)
    default:
      return false
  }
}
