import type { Accessor } from "solid-js"
import type { AgentTurnOutcome } from "@claxedo/agent-runtime-contract"
import { type PairedTranscriptTypography } from "@/ui"
import type { SessionStatus } from "@/server"
import type { TranscriptConversation } from "@/transcript"

export type TurnOutcome = AgentTurnOutcome

export type TimelineSessionRow = {
  readonly id: string
  readonly title?: string
  readonly parentId?: string
  readonly archived: boolean
  readonly lastTurn?: TurnOutcome
}

export type TimelineTextKey =
  | "command.session.new"
  | "common.archive"
  | "common.cancel"
  | "common.delete"
  | "common.moreOptions"
  | "common.rename"
  | "common.requestFailed"
  | "session.delete.button"
  | "session.delete.confirm"
  | "session.delete.failed.title"
  | "session.delete.title"
  | "session.timeline.collapseTranscript"
  | "session.timeline.previousMessages.one"
  | "session.timeline.previousMessages.other"
  | "session.timeline.scrollToBottom"
  | "ui.common.file.one"
  | "ui.common.file.other"
  | "ui.message.attachment.alt"
  | "ui.message.interrupted"
  | "ui.message.interruptedDuration"
  | "ui.message.queued"
  | "ui.message.queued.accepted"
  | "ui.message.queued.cancelEdit"
  | "ui.message.queued.dispatching"
  | "ui.message.queued.edit"
  | "ui.message.queued.editing"
  | "ui.message.queued.loadFailed"
  | "ui.message.queued.remove"
  | "ui.message.queued.retry"
  | "ui.message.queued.sendNow"
  | "ui.message.queued.unknown"
  | "ui.message.revertMessage"
  | "ui.messagePart.compaction"
  | "ui.sessionTurn.diffs.changed"
  | "ui.sessionTurn.diffs.more"
  | "ui.sessionTurn.diffs.showAll"
  | "ui.sessionTurn.diffs.showLess"
  | "ui.sessionTurn.status.thinking"

export type TimelineTranslate = (key: TimelineTextKey, params?: Record<string, string | number>) => string

export type TimelineSettings = {
  readonly showReasoningSummaries: Accessor<boolean>
  readonly shellToolPartsExpanded: Accessor<boolean>
  readonly editToolPartsExpanded: Accessor<boolean>
  readonly timelineShowTurnTokens: Accessor<boolean>
}

export type TimelinePlatform = {
  readonly openLink: (url: string) => void
  readonly renderMermaid?: (source: string, theme?: Record<string, string>) => Promise<string>
}

export type TimelineFocus =
  | { readonly kind: "file"; readonly path: string; readonly line?: number; readonly col?: number }
  | { readonly kind: "browser"; readonly url: string }
  | {
      readonly kind: "plan"
      readonly sessionId: string
      readonly planId: string
      readonly markdown: string
      readonly title?: string
    }
  | { readonly kind: "subagent"; readonly sessionId: string; readonly label?: string; readonly description?: string }

export type TimelineNavigation = {
  readonly toSession: (sessionId: string) => void
}

export type TimelineHost = {
  readonly sessionKey: Accessor<string>
  readonly sessionId: Accessor<string | undefined>
  readonly placementPath: string
  readonly conversation: Accessor<TranscriptConversation | undefined>
  readonly parentConversation: Accessor<TranscriptConversation | undefined>
  readonly sessions: Accessor<readonly TimelineSessionRow[]>
  readonly status: Accessor<SessionStatus>
  readonly turnSettlePending: (userMessageId: string) => boolean
  readonly seededTurnFoldableCounts?: Record<string, number>
  readonly syncSession?: (sessionId: string) => Promise<unknown>
  readonly settings: TimelineSettings
  readonly transcriptTypography: Accessor<PairedTranscriptTypography>
  readonly t: TimelineTranslate
  readonly platform: TimelinePlatform
  readonly openFocus: (focus: TimelineFocus) => void
  readonly openSessionInPane: (sessionId: string, label?: string) => void
  readonly findFiles: (query: string, signal: AbortSignal) => Promise<readonly string[]>
  readonly navigation: TimelineNavigation
}

export type QueuedMessage = {
  readonly seq: number
  readonly messageId?: string
  readonly queuedAt: number
  readonly parts: ReadonlyArray<{ readonly type: string; readonly text?: string; readonly filename?: string }>
  readonly held: boolean
  readonly steering?: {
    readonly mode: "start" | "steer"
    readonly operationId: string
    readonly state: "dispatching" | "accepted" | "unknown" | "rejected"
    readonly message?: string
  }
}

export type QueuedMessages = {
  readonly items: Accessor<readonly QueuedMessage[]>
  readonly loadFailed: Accessor<boolean>
  readonly pending: Accessor<number | undefined>
  readonly error: Accessor<string | undefined>
  readonly editing: Accessor<number | undefined>
  readonly reload: () => void
  readonly sendNow: (seq: number) => void
  readonly remove: (seq: number) => void
  readonly beginEdit: (record: QueuedMessage) => void
  readonly cancelEdit: (seq: number) => void
}

export function queuedMessageText(record: QueuedMessage): string {
  return record.parts.filter((part) => part.type === "text" && !!part.text).map((part) => part.text).join("\n")
}

export function turnActive(status: SessionStatus): boolean {
  if (status.kind === "working" || status.kind === "retrying") return true
  return status.kind === "recovering" && "reason" in status && status.reason === "uncertainExecution"
}
