import type { TranscriptNotice, TranscriptNoticeSeverity } from "@claxedo/agent-runtime-contract"
import type { TranscriptTextKey } from "./i18n"

export type NoticeMessage = { readonly text: string } | { readonly key: "transcript.notice.compactionFailed"; readonly error: string }

export type NoticeView =
  | { readonly shape: "boundary"; readonly key: Extract<TranscriptTextKey, "transcript.notice.compacting" | "transcript.messagePart.compaction"> }
  | { readonly shape: "row"; readonly tone: TranscriptNoticeSeverity; readonly message: NoticeMessage }

export function noticeView(notice: TranscriptNotice): NoticeView {
  switch (notice.kind) {
    case "harness":
      return { shape: "row", tone: notice.severity, message: { text: notice.message } }
    case "compaction":
      if (notice.status === "running") return { shape: "boundary", key: "transcript.notice.compacting" }
      if (notice.status === "completed") return { shape: "boundary", key: "transcript.messagePart.compaction" }
      return { shape: "row", tone: "warn", message: { key: "transcript.notice.compactionFailed", error: notice.error } }
  }
}
