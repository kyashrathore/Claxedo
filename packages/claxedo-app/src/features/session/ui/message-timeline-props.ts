import type { Accessor } from "solid-js"
import type { UserMessage } from "@/features/session/ui/history-window"
import type { SessionStatus } from "@/features/session/data/sync/queries"
import type { UserActions } from "@/ui/session-kit"
import type { SessionErrorClass } from "@/features/session/onboarding/first-turn-recovery"
import type { ClaxedoSession } from "@/features/session/data/session-types"
import type { SessionRef } from "@/platform/identity/session-ref"
import type { QueuedMessagesController } from "@/features/session/queue/queued-messages-controller"

export type MessageTimelineProps = {
  onSessionDeleted?: (sessionId: string) => void
  active: () => boolean
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
  onAutoScrollInteraction: (event: MouseEvent) => void
  shouldAnchorBottom: () => boolean
  hasScrollTarget: () => boolean
  restoreFollowing: (following: boolean) => void
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  historyShift: boolean
  userMessages: UserMessage[]
  /** Turns above `userMessages[0]` that the history window keeps off-screen; > 0 adds the reveal row. */
  hiddenTurnCount?: Accessor<number>
  /** Suppresses the sticky session title; a floating card shows only the turn. */
  hideTitle?: Accessor<boolean>
  onRevealPreviousMessages?: () => void
  navMessages?: UserMessage[]
  currentMessage?: UserMessage
  onMessageSelect?: (message: UserMessage) => void
  status: () => SessionStatus
  anchor: (id: string) => string
  setScrollToEnd?: (fn: () => void) => void
  setScrollToMessage?: (fn: ((id: string, behavior: ScrollBehavior) => boolean) | undefined) => void
  setHistoryAnchor?: (handlers: { capture: () => void; restore: () => void }) => void
  onFirstTurnRecovery?: (kind: SessionErrorClass, userMessageID: string) => unknown
  firstTurnRecovery?: boolean
  title: () => string | undefined
  sessionRef?: SessionRef
  parentID?: string
  onNavigateParent: () => void
  directorySessions: Accessor<ClaxedoSession[]>
  workspaceId?: string
  /** Prompts the runtime holds for the next turn, drawn after the last row. */
  queued?: QueuedMessagesController
}
