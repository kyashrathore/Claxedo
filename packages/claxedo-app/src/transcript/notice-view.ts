import type { TranscriptNotice, TranscriptNoticeSeverity } from "@claxedo/agent-runtime-contract"
import type { TranscriptTextKey } from "./i18n"

export type NoticeMessage = { readonly text: string } | { readonly key: "transcript.notice.compactionFailed"; readonly error: string }

type BoundaryKey = Extract<TranscriptTextKey,
  "transcript.notice.compacting" | "transcript.messagePart.compaction" | "transcript.notice.conversationCleared" | "transcript.notice.conversationReset">

export type NoticeView =
  | { readonly shape: "boundary"; readonly key: BoundaryKey; readonly icon: "archive" | "new-session" }
  | { readonly shape: "row"; readonly tone: TranscriptNoticeSeverity; readonly message: NoticeMessage }

export function noticeView(notice: TranscriptNotice): NoticeView {
  switch (notice.kind) {
    case "harness":
      return { shape: "row", tone: notice.severity, message: { text: notice.message } }
    case "compaction":
      if (notice.status === "running") return { shape: "boundary", key: "transcript.notice.compacting", icon: "archive" }
      if (notice.status === "completed") return { shape: "boundary", key: "transcript.messagePart.compaction", icon: "archive" }
      return { shape: "row", tone: "warn", message: { key: "transcript.notice.compactionFailed", error: notice.error } }
    case "conversation-reset":
      return { shape: "boundary", key: notice.trigger === "clear" ? "transcript.notice.conversationCleared" : "transcript.notice.conversationReset", icon: "new-session" }
  }
}

export function retractionLabel(reason: string): Extract<TranscriptTextKey, "transcript.retracted.refusal" | "transcript.retracted.other"> {
  return reason === "refusal" ? "transcript.retracted.refusal" : "transcript.retracted.other"
}
