import type { Accessor } from "solid-js"
import type { TranscriptUserMessage, UserActions } from "@/transcript"
import type { SessionErrorClass } from "./turn-recovery"
import type { QueuedMessages, TimelineHost } from "./model"

export type MessageTimelineProps = {
  host: TimelineHost
  active: () => boolean
  onScreen: Accessor<boolean>
  actions?: UserActions
  scroll: { overflow: boolean; bottom: boolean; jump: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleScroll: () => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  onUserScroll: () => void
  onHistoryScroll: () => void
  onHistoryPull?: () => void
  shouldAnchorBottom: () => boolean
  olderPending?: Accessor<boolean>
  hasScrollTarget: () => boolean
  restoreFollowing: (following: boolean) => void
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  historyShift: boolean
  userMessages: TranscriptUserMessage[]
  hiddenTurnCount?: Accessor<number>
  onRevealPreviousMessages?: () => void
  navMessages?: TranscriptUserMessage[]
  currentMessage?: TranscriptUserMessage
  onMessageSelect?: (message: TranscriptUserMessage) => void
  progressBlocked?: Accessor<boolean>
  anchor: (id: string) => string
  setScrollToEnd?: (fn: () => void) => void
  setScrollToMessage?: (fn: ((id: string, behavior: ScrollBehavior) => boolean) | undefined) => void
  setHistoryAnchor?: (handlers: { capture: () => void; restore: () => void }) => void
  onFirstTurnRecovery?: (kind: SessionErrorClass, userMessageId: string) => unknown
  firstTurnRecovery?: boolean
  title: () => string | undefined
  parentId?: string
  queued?: QueuedMessages
}
