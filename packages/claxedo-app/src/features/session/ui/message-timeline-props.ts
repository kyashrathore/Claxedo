import type { Accessor } from "solid-js"
import type { UserMessage } from "@/features/session/ui/history-window"
import type { SessionStatus } from "@/features/session/data/sync/queries"
import type { UserActions } from "@/ui/session-kit"
import type { SessionErrorClass } from "@/features/session/onboarding/first-turn-recovery"
import type { ClaxedoSession } from "@/features/session/data/session-types"
import type { SessionRef } from "@/platform/identity/session-ref"

export type MessageTimelineProps = {
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
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  historyShift: boolean
  userMessages: UserMessage[]
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
}
