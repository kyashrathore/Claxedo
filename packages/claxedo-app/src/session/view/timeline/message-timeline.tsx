import { asRecord } from "@claxedo/helpers/guards"
import { readString } from "@claxedo/helpers/readers"
import { sameArrayItems, samePartsRecord, sameTurnOutcome } from "./timeline-row-equality"
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  mapArray,
  Switch,
  untrack,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { createVirtualizer, elementScroll, type Range } from "@tanstack/solid-virtual"
import { observeElementOffsetReconnectAware, observeElementRectDeduped } from "./message-timeline-observe-offset"
import { assistantMessageSettled, isSubagentToolPart, type PartRef } from "@claxedo/agent-runtime-contract/turn-fold"
import {
  ContextToolGroup,
  MessageNav,
  MessageDivider,
  Part as MessagePart,
  partDefaultOpen,
  SubagentChipRow,
  TurnFoldRow,
  WorkGroup,
} from "@/transcript"
import { isPhoneWidth } from "@/lib/viewport"
import { holdPaneReveal } from "@/workbench"
import { ScrollView, showToast } from "@/ui"
import { Binary, resolveTranscriptTypography, transcriptTypographyStyle } from "@/ui/utils"
import { ClaxedoSessionRetry } from "./claxedo-session-retry"
import { TimelineErrorPresentation } from "./first-turn-recovery-card"
import { TimelineJumpButton } from "./timeline-jump-button"
import { TimelineQueuedMessages } from "./timeline-queued-messages"
import type {
  AgentAssistantMessage as AssistantMessage,
  AgentContentPart as PartType,
  AgentToolPart as ToolPart,
} from "@claxedo/agent-runtime-contract"
import { createTimelineListGestures } from "./message-timeline-list-gestures"
import { useData } from "@/transcript"
import { sessionTitle } from "./session-title"
import { latchSessionTitle, type LatchedSessionTitle } from "./session-title-latch"
import { createActivePaneProjection } from "./active-pane-projection"
import { whileOnScreen } from "./timeline-on-screen"
import { MessageComment, Timeline } from "./message-timeline.data"
import { MessageCommentChip } from "./message-comment-chip"
import { TimelineRow, type TimelineRowMap } from "./timeline-row-model"
import { PreviousMessagesRow, TimelineDiffSummaryRow, TimelineThinkingRow } from "./message-timeline-turn-rows"
import { nextThinkingVisibilityHold } from "./thinking-visibility-hold"
import { createTimelineFileContextMenu, TimelineFileContextMenu } from "./timeline-file-context-menu"
import { TimelineBackgroundWork } from "./timeline-background-work"
import { backgroundWorkActive } from "@/server"
import { isOptimisticMessage, isRuntimeMessage } from "../../transcript/merge"
import {
  timelineInitialRevealShouldScroll,
  timelineInitialRevealVisibility,
  timelineInteractionPlan,
  timelineVirtualEntry,
} from "./timeline-view-state"
import { createTimelinePrependAnchor } from "./timeline-prepend-anchor"
import { timelineRenderIndexes } from "./timeline-render-range"
import {
  createTimelineResizeAnchor,
  estimateTimelineRowSize,
  fixedRowHeights,
  measureUnmeasuredRows,
  scheduleConnectedMeasure,
  timelineRowFrameStyle,
} from "./timeline-virtualization"
import { readTimelineMountSnapshot, writeTimelineMountSnapshot } from "./timeline-mount-cache"
import { createTimelineScrollMemory } from "./timeline-scroll-memory"
import { createTurnFoldStore } from "./turn-fold-store"
import { formatDuration } from "@/transcript"
import { installTimelineMermaid } from "./mermaid-timeline"
import { installTimelineTables } from "./table-timeline"
import { sessionMessageScrollInset } from "./session-message-scroll-position"
import type { TranscriptUserMessage as UserMessage } from "@/transcript"
import { TimelineUserMessage } from "./timeline-user-message"
import {
  timelineFileCandidateIsOpenable,
  timelineFileFocus,
  resolveTimelinePath as resolveTimelineFilePath,
} from "./timeline-file-paths"
import { createTimelineLinkOpen } from "./timeline-link-open"
import { createMessageNavRoom } from "./message-nav-layout"
import { messageNavPreview, messageNavVisible } from "./message-nav-preview"
import { scheduleTimelineFirstFoldReveal } from "./timeline-first-fold-reveal"
import type { MessageTimelineProps } from "./message-timeline-props"
import type { ConversationMessage } from "@/transcript"
import { turnActive, type TimelineSessionRow } from "./model"
import type { TimelineNavTurn } from "./model"
import "./timeline-viewport.css"
import "./markdown-surfaces.css"

const emptyMessages: ConversationMessage[] = []
const emptyParts: PartType[] = []

const ownParts = (message: ConversationMessage | undefined) => (message && isOptimisticMessage(message) ? message.parts : emptyParts)
const emptyAssistantMessages: AssistantMessage[] = []
const idle = { kind: "idle" as const }

type FramedTimelineRow = Exclude<TimelineRow.TimelineRow, { _tag: "TurnGap" }>
type TimelineRowByTag<T extends TimelineRow.TimelineRow["_tag"]> = Extract<TimelineRow.TimelineRow, { _tag: T }>

function hasTag<Tag extends TimelineRow.TimelineRow["_tag"]>(
  row: TimelineRow.TimelineRow,
  tag: Tag,
): row is TimelineRowByTag<Tag> {
  return row._tag === tag
}

function rowOfTag<Tag extends TimelineRow.TimelineRow["_tag"]>(
  row: Accessor<TimelineRow.TimelineRow>,
  tag: Tag,
  seed: TimelineRowByTag<Tag>,
): Accessor<TimelineRowByTag<Tag>> {
  return createMemo<TimelineRowByTag<Tag>>((previous) => {
    const next = row()
    return hasTag(next, tag) ? next : previous
  }, seed)
}

const timelineFallbackItemSize = 60

const taskDescription = (part: PartType, sessionId: string) => {
  if (part.type !== "tool" || !isSubagentToolPart(part)) return undefined
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  if (metadata?.sessionId !== sessionId) return undefined
  const value = part.state.input?.description
  if (typeof value === "string" && value) return value
  return undefined
}

export function MessageTimeline(props: MessageTimelineProps) {
  const host = props.host
  const data = useData()
  const typography = createMemo(() => resolveTranscriptTypography(host.transcriptTypography()))
  const transcriptStyle = createMemo(() => transcriptTypographyStyle(typography()))
  const ownerSessionKey = host.sessionKey()
  const cached = readTimelineMountSnapshot(ownerSessionKey)
  const savedScroll = cached?.scroll
  if (savedScroll && !props.hasScrollTarget()) props.restoreFollowing(savedScroll.following)
  const initialMeasurements = cached?.measurements
  const warmMeasurements = !!initialMeasurements?.length
  const boundColdFinalTurn = !warmMeasurements && host.status().kind === "idle"
  const [initialTurnExpanded, setInitialTurnExpanded] = createSignal(!boundColdFinalTurn)
  const turnFold = createTurnFoldStore(ownerSessionKey)
  const [toolOpen, setToolOpen] = createStore<Record<string, boolean | undefined>>(cached?.toolOpen ?? {})
  const [groupOpen, setGroupOpen] = createStore<Record<string, boolean | undefined>>(cached?.groupOpen ?? {})
  const toggleTool = (partId: string, open: boolean) => {
    props.onReaderToggle()
    setToolOpen(partId, open)
  }
  const [toolRevealed, setToolRevealed] = createStore<Record<string, boolean | undefined>>(cached?.toolRevealed ?? {})
  const revealToolOutput = (partId: string, revealed: boolean) => {
    props.onMarkScrollGesture()
    setToolRevealed(partId, revealed)
  }
  installTimelineMermaid(host.platform.renderMermaid)
  installTimelineTables()

  const openSubagent = (input: { childSessionId: string; label?: string; description?: string }) => {
    if (isPhoneWidth(window.innerWidth)) {
      host.openSessionInPane(input.childSessionId, input.label)
      return
    }
    host.openFocus({
      kind: "subagent",
      sessionId: input.childSessionId,
      ...(input.label ? { label: input.label } : {}),
      ...(input.description ? { description: input.description } : {}),
    })
  }

  const fileFocus = (raw: string) => timelineFileFocus(raw, host.placementPath)

  let candidateFileController: AbortController | undefined
  onCleanup(() => candidateFileController?.abort())
  createEffect(() => {
    if (!props.active()) candidateFileController?.abort()
  })
  const handleTimelinePathClick = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    const target = event.target instanceof Element ? event.target : null
    const selection = typeof window !== "undefined" ? window.getSelection() : null
    if (selection && !selection.isCollapsed) return
    if (target?.closest("a[href]")) return
    const chip = target?.closest<HTMLElement>('[data-inline-code-kind="path"], [data-inline-code-kind="path-candidate"]')
    const raw = chip?.textContent?.trim()
    if (!raw || !fileFocus(raw)) return
    event.preventDefault()
    if (chip?.dataset.inlineCodeKind === "path") {
      links.openFile(raw)
      return
    }
    candidateFileController?.abort()
    const controller = new AbortController()
    candidateFileController = controller
    void timelineFileCandidateIsOpenable(raw, host.placementPath, (query) =>
      host.findFiles(query, controller.signal),
    ).then((openable) => {
      if (!openable || controller.signal.aborted || !props.active()) return
      if (!chip?.isConnected || chip.textContent?.trim() !== raw) return
      chip.dataset.inlineCodeKind = "path"
      links.openFile(raw)
    })
  }
  const [timelineRoot, setTimelineRoot] = createSignal<HTMLDivElement>()
  const messageNavHasRoom = createMessageNavRoom(timelineRoot)
  const messageNavGutterVisible = createMemo(() =>
    messageNavVisible((props.navMessages ?? props.userMessages).length) && messageNavHasRoom() && !!props.onMessageSelect,
  )

  const links = createTimelineLinkOpen({
    openFocus: host.openFocus,
    platform: host.platform,
    get placementPath() { return host.placementPath },
    onError: (error) => {
      console.warn("Transcript file could not be opened", { error })
      showToast({ title: host.t("common.requestFailed"), description: error instanceof Error ? error.message : String(error), variant: "error" })
    },
  })

  const registerTimelineRoot = (el: HTMLDivElement) => {
    setTimelineRoot(el)
    const stopLinkOpen = links.listen(el)
    const onOpenSubagent = (event: Event) => {
      const detail = event instanceof CustomEvent ? asRecord(event.detail) : undefined
      const childSessionId = readString(detail, "childSessionId")
      if (!childSessionId) return
      event.preventDefault()
      openSubagent({
        childSessionId,
        label: readString(detail, "label"),
        description: readString(detail, "description"),
      })
    }
    el.addEventListener("claxedo:open-subagent", onOpenSubagent)
    const onOpenPlan = (event: Event) => {
      const detail = event instanceof CustomEvent ? asRecord(event.detail) : undefined
      const sessionId = readString(detail, "sessionId")
      const planId = readString(detail, "planId")
      const markdown = readString(detail, "markdown")
      if (!sessionId || !planId || !markdown) return
      event.preventDefault()
      const title = readString(detail, "title")
      host.openFocus({ kind: "plan", sessionId, planId, markdown, ...(title ? { title } : {}) })
    }
    el.addEventListener("claxedo:open-plan", onOpenPlan)
    onCleanup(() => {
      stopLinkOpen()
      el.removeEventListener("claxedo:open-subagent", onOpenSubagent)
      el.removeEventListener("claxedo:open-plan", onOpenPlan)
    })
  }

  const fileMenu = createTimelineFileContextMenu()

  const [listRoot, setListRoot] = createSignal<HTMLDivElement>()
  const sessionId = createMemo(() => host.sessionId())
  const sessionConversation = host.conversation
  const sessionMessages = createMemo(whileOnScreen(props.onScreen, () => sessionConversation()?.messages ?? emptyMessages))
  const messageById = createMemo(() => new Map(sessionMessages().map((message) => [message.id, message] as const)))
  const queuedNotYetInTranscript = createMemo(() =>
    (props.queued?.items() ?? []).filter((item) => !item.messageId || !messageById().has(item.messageId)),
  )
  const assistantMessagesByParent = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    for (const message of sessionMessages()) {
      if (!isRuntimeMessage(message) || message.role !== "assistant") continue
      const messages = result.get(message.parentID)
      if (messages) {
        messages.push(message)
        continue
      }
      result.set(message.parentID, [message])
    }
    return result
  })
  const pending = createMemo(() =>
    sessionMessages().findLast(
      (item): item is AssistantMessage =>
        isRuntimeMessage(item) && item.role === "assistant" && typeof item.time.completed !== "number",
    ),
  )
  const displayed = () => props.active() && props.onScreen()
  const sessionStatus = createActivePaneProjection({ active: displayed, read: () => host.status() ?? idle, initial: idle })
  const turnSettleRefreshPending = (userMessageId: string) => host.turnSettlePending(userMessageId)
  const working = createMemo(() => turnActive(sessionStatus()))
  const directorySessionRows = createActivePaneProjection({ active: displayed, read: host.sessions, initial: [] as readonly TimelineSessionRow[] })
  const directorySession = (sessionId: string | undefined) =>
    sessionId ? directorySessionRows().find((session) => session.id === sessionId) : undefined
  const resolveAmbientSubagents = () => {
    const id = sessionId()
    if (!id) return []
    return (data.resolveSubagents?.(id) ?? []).filter((subagent) => subagent.ambient)
  }
  const ambientSubagents = createActivePaneProjection({
    active: displayed,
    read: resolveAmbientSubagents,
    initial: [] as ReturnType<typeof resolveAmbientSubagents>,
  })

  const activeMessageId = createMemo(() => {
    const messages = sessionMessages()
    let lastUserIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") { lastUserIndex = i; break }
    }
    const parentId = pending()?.parentID
    if (parentId) {
      const result = Binary.search(messages, parentId, (message) => message.id)
      const index = result.found ? result.index : messages.findIndex((item) => item.id === parentId)
      const message = index >= 0 ? messages[index] : undefined
      if (message && message.role === "user" && index >= lastUserIndex) return message.id
    }

    if (lastUserIndex < 0) return undefined
    const newest = messages[lastUserIndex].id
    if (sessionStatus().kind !== "idle" || turnSettleRefreshPending(newest)) return newest
    return undefined
  })
  const info = createMemo(() => {
    const id = sessionId()
    if (!id) return undefined
    return directorySession(id)
  })
  const titleSource = createActivePaneProjection<string | undefined>({ active: props.active, read: props.title, initial: undefined })
  const latchedTitle = createMemo<LatchedSessionTitle | undefined>((previous) => latchSessionTitle(previous, { sessionKey: host.sessionKey(), title: titleSource() }))
  const titleLabel = createMemo(() => sessionTitle(latchedTitle()?.title))
  const parentId = createMemo(() => props.parentId)
  const parentConversation = host.parentConversation
  const parentMessages = createMemo(() => parentConversation()?.messages ?? emptyMessages)
  const getMsgParts = (msgId: string) => sessionConversation()?.parts[msgId] ?? ownParts(messageById().get(msgId))
  const getParentMsgParts = (msgId: string) => parentConversation()?.parts[msgId] ?? emptyParts
  const turnPreview = (turn: TimelineNavTurn) =>
    turn.preview ??
    messageNavPreview({
      userMessageId: turn.id,
      assistantMessageIds: (assistantMessagesByParent().get(turn.id) ?? emptyAssistantMessages).map((item) => item.id),
      getParts: getMsgParts,
    })
  const childTaskDescription = createMemo(() => {
    const id = sessionId()
    if (!id) return undefined
    return parentMessages()
      .flatMap((message) => getParentMsgParts(message.id))
      .map((part) => taskDescription(part, id))
      .findLast((value): value is string => !!value)
  })
  const childTitle = createMemo(() => {
    if (!parentId()) return titleLabel() ?? ""
    if (childTaskDescription()) return childTaskDescription()
    const value = titleLabel()?.replace(/\s+\(@[^)]+ subagent\)$/, "")
    if (value) return value
    return host.t("command.session.new")
  })

  const statusType = createMemo(() => sessionStatus().kind)
  const lastTurnOutcome = createMemo(() => info()?.lastTurn, undefined, { equals: sameTurnOutcome })
  const messageRowMemos = createMemo(
    mapArray(
      () => props.userMessages,
      (userMessage, indexAccessor) => {
        const turnAssistants = createMemo(
          () => assistantMessagesByParent().get(userMessage.id) ?? emptyAssistantMessages,
          undefined,
          { equals: sameArrayItems },
        )
        const turnParts = createMemo(
          whileOnScreen(props.onScreen, () => {
            const conversation = sessionConversation()
            const parts: Record<string, PartType[]> = {
              [userMessage.id]: unwrap(conversation?.parts[userMessage.id]) ?? emptyParts,
            }
            for (const message of turnAssistants()) {
              parts[message.id] = unwrap(conversation?.parts[message.id]) ?? emptyParts
            }
            return parts
          }),
          undefined,
          { equals: samePartsRecord },
        )
        const gap = TimelineRow.TurnGap({ userMessageId: userMessage.id })
        const last = createMemo(() => indexAccessor() === props.userMessages.length - 1)
        const visibleAssistantMessageIds = createMemo(() => {
          if (initialTurnExpanded() || !last()) return undefined
          const parts = turnParts()
          return Timeline.coldFinalVisibleAssistantMessageIds(
            turnAssistants(),
            (messageId) => parts[messageId] ?? emptyParts,
          )
        })
        const isActive = createMemo(() => activeMessageId() === userMessage.id)
        const turnStatus = createMemo(() => (isActive() ? statusType() : "idle"))
        const turnOutcome = createMemo(
          () => {
            const outcome = lastTurnOutcome()
            return outcome && turnAssistants().some((message) => message.id === outcome.assistantMessageId) ? outcome : undefined
          },
          undefined,
          { equals: sameTurnOutcome },
        )
        const settling = createMemo(() => turnSettleRefreshPending(userMessage.id))
        const thinkingHeading = createMemo(() => {
          if (!isActive() || (turnStatus() !== "working" && !settling())) return undefined
          const conversation = sessionConversation()
          return Timeline.reasoningHeadingOf(turnAssistants().flatMap((message) => conversation?.parts[message.id] ?? emptyParts))
        })
        const textParts = createMemo(
          () => {
            const conversation = sessionConversation()
            return Object.values(turnParts()).flatMap((parts) => parts.flatMap((part) => (conversation?.partsWithText[part.id] === true ? [part.id] : [])))
          },
          undefined,
          { equals: sameArrayItems },
        )
        const turnRows = createMemo(whileOnScreen(props.onScreen, (previous: TimelineRow.TimelineRow[] | undefined) => {
          const parts = turnParts()
          const withText = new Set(textParts())
          const rows = Timeline.constructMessageRows(
            userMessage,
            (messageId) => parts[messageId] ?? emptyParts,
            (part) => withText.has(part.id),
            turnAssistants(),
            host.settings.showReasoningSummaries(),
            turnStatus(),
            isActive(),
            (userMessageId) => turnFold.isFolded(userMessageId),
            turnOutcome(),
            visibleAssistantMessageIds(),
            (partId) => toolOpen[partId] === true || toolRevealed[partId] === true,
            settling(),
            thinkingHeading(),
          )
          return TimelineRow.reuse(previous, rows)
        }))
        return { gap, rows: turnRows }
      },
    ),
  )

  let thinkingHeldUntilMs: number | undefined
  let thinkingHoldTimer: ReturnType<typeof setTimeout> | undefined
  const [thinkingHoldRevision, setThinkingHoldRevision] = createSignal(0)
  onCleanup(() => {
    if (thinkingHoldTimer) clearTimeout(thinkingHoldTimer)
  })

  const hiddenTurnsRow = () => {
    const count = props.hiddenTurnCount?.() ?? 0
    const head = props.userMessages[0]
    if (count <= 0 || !head) return undefined
    return TimelineRow.PreviousMessages({ userMessageId: head.id, count })
  }

  const timelineRows = createMemo(whileOnScreen(props.onScreen, (previous: TimelineRow.TimelineRow[] | undefined) => {
    thinkingHoldRevision()
    const rows = messageRowMemos().flatMap((turn, index) => (index === 0 ? turn.rows() : [turn.gap, ...turn.rows()]))
    const hiddenTurns = hiddenTurnsRow()
    if (hiddenTurns) rows.unshift(hiddenTurns)
    const wantThinking = rows.some((row) => row._tag === "Thinking")
    const hold = nextThinkingVisibilityHold({
      want: wantThinking,
      blocked: props.progressBlocked?.(),
      heldUntilMs: thinkingHeldUntilMs,
      nowMs: performance.now(),
    })
    thinkingHeldUntilMs = hold.heldUntilMs
    if (thinkingHoldTimer) {
      clearTimeout(thinkingHoldTimer)
      thinkingHoldTimer = undefined
    }
    if (hold.heldUntilMs !== undefined) {
      const remaining = Math.max(0, hold.heldUntilMs - performance.now())
      thinkingHoldTimer = setTimeout(() => setThinkingHoldRevision((value) => value + 1), remaining)
    }

    if (hold.visible && !wantThinking) {
      const previousThinking = previous?.find((row) => row._tag === "Thinking")
      if (previousThinking) {
        const withoutTrailingThinking = rows.filter((row) => row._tag !== "Thinking")
        return TimelineRow.reuse(previous, [...withoutTrailingThinking, previousThinking])
      }
    }

    return TimelineRow.reuse(previous, props.progressBlocked?.() ? rows.filter((row) => row._tag !== "Thinking") : rows)
  }))

  const [firstViewSettled, setFirstViewSettled] = createSignal(false)
  const followsEnd = () => props.shouldAnchorBottom() && (working() || !firstViewSettled())
  const prepend = createTimelinePrependAnchor({
    root: listRoot, displayed, following: followsEnd,
    resolveRowStart: (key) => {
      const index = timelineRows().findIndex((row) => TimelineRow.key(row) === key)
      return index < 0 ? undefined : virtualizer.getOffsetForIndex(index, "start")?.[0]
    },
  })
  onCleanup(prepend.clear)
  const initialRowCount = timelineRows().length
  const [renderOverscan, setRenderOverscan] = createSignal(1)
  const [initialRevealReady, setInitialRevealReady] = createSignal(warmMeasurements || initialRowCount === 0)
  const [progressiveReady, setProgressiveReady] = createSignal(warmMeasurements || initialRowCount === 0)
  const messageNavMountReady = createMemo<boolean>((mounted) => mounted || (props.active() && initialRevealReady() && messageNavGutterVisible()), false)
  holdPaneReveal(() => !initialRevealReady())
  let initialRowsScheduled = initialRowCount > 0
  let cancelFirstFoldReveal: (() => void) | undefined
  const prepareScrollOverscan = () => {
    if (!initialTurnExpanded()) setInitialTurnExpanded(true)
    if (renderOverscan() < 6) setRenderOverscan(6)
  }
  const prepareInteractionScroll = () => {
    const plan = timelineInteractionPlan({
      prependLoading: prepend.loading(),
      hasScrollGesture: props.hasScrollGesture(),
    })
    if (plan.prepareOverscan) prepareScrollOverscan()
    if (plan.settlePrependAnchor) prepend.settle()
    return plan
  }
  let virtualContent: HTMLDivElement | undefined
  const resizeAnchor = createTimelineResizeAnchor()
  const rowKeys = createMemo(() => {
    const keys = timelineRows().map(TimelineRow.key)
    resizeAnchor.noteRowKeys(keys)
    return keys
  })
  const itemKey = createMemo(() => {
    const keys = rowKeys()
    return (index: number) => keys[index] ?? `removed:${index}`
  })
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return timelineRows().length
    },
    getScrollElement: () => listRoot() ?? null,
    observeElementRect: (instance, observed) =>
      observeElementRectDeduped(instance, (rect) => {
        observed(rect)
        host.recordViewport(rect)
      }),
    observeElementOffset: observeElementOffsetReconnectAware,
    initialRect: {
      width: typeof window === "undefined" ? 0 : window.innerWidth,
      height: typeof window === "undefined" ? 0 : window.innerHeight,
    },
    initialOffset: () => props.shouldAnchorBottom() ? Number.MAX_SAFE_INTEGER : (savedScroll?.offset ?? 0),
    initialMeasurementsCache: initialMeasurements,
    estimateSize: (index) =>
      untrack(() => estimateTimelineRowSize({ index, rows: timelineRows(), parts: getMsgParts, fixed: fixedRowHeights(typography()) })),
    scrollToFn: (offset, options, instance) => {
      if (virtualContent) virtualContent.style.height = `${instance.getTotalSize()}px`
      elementScroll(offset, options, instance)
    },
    get getItemKey() {
      return itemKey()
    },
    get anchorTo() {
      return followsEnd() ? "end" : "start"
    },
    get followOnAppend() {
      return props.active() && followsEnd() && !resizeAnchor.held()
    },
    get scrollEndThreshold() {
      return resizeAnchor.held() || props.hasScrollGesture() ? -1 : 80
    },
    get overscan() { return renderOverscan() },
    paddingEnd: 64,
    get rangeExtractor() {
      const rows = timelineRows()
      const activeId = activeMessageId()
      const overscan = renderOverscan()
      const pinned = resizeAnchor.pinnedIndexes()
      return (range: Range) => timelineRenderIndexes({ rows, activeMessageId: activeId, pinned, range, overscan })
    },
  })
  createEffect(() => {
    if (firstViewSettled()) return
    virtualRowKeys()
    measureUnmeasuredRows(virtualizer)
    if (props.hasScrollGesture()) setFirstViewSettled(true)
  })
  resizeAnchor.install({
    virtualizer,
    root: listRoot,
    displayed,
    shouldAnchorBottom: followsEnd,
    hasScrollGesture: props.hasScrollGesture,
    holdsInViewInserts: firstViewSettled,
    onInViewInsert: () => props.onMarkScrollGesture(),
    followsInsertBeside: TimelineRow.keyIsThinking,
  })
  const scrollMemory = createTimelineScrollMemory({
    initial: savedScroll, active: props.active, root: listRoot,
    following: props.shouldAnchorBottom, hasTarget: props.hasScrollTarget,
    restoreFollowing: props.restoreFollowing, restoring: () => prepend.running(),
    scrollToOffset: (offset) => virtualizer.scrollToOffset(offset),
    scrollToEnd: () => virtualizer.scrollToEnd(),
    restoreAnchor: prepend.apply,
  })
  createEffect(() => {
    if (props.active()) prepend.resume()
  })
  const timelineRowByKey = createMemo(() => new Map(timelineRows().map((row) => [TimelineRow.key(row), row] as const)))
  const virtualItemByKey = createMemo(
    () => new Map(virtualizer.getVirtualItems().map((item) => [String(item.key), item] as const)),
  )
  const virtualRowKeys = createMemo(() => (props.onScreen() ? virtualizer.getVirtualItems().map((item) => String(item.key)) : []))
  const messageRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    timelineRows().forEach((row, index) => {
      if (!TimelineRow.anchorsMessage(row)) return
      result.set(row.userMessageId, index)
    })
    return result
  })
  const lastAssistantGroupKey = createMemo(() => {
    const result = new Map<string, string>()
    timelineRows().forEach((row) => {
      if (row._tag !== "AssistantPart") return
      result.set(row.userMessageId, row.group.key)
    })
    return result
  })
  const [viewportMessageId, setViewportMessageId] = createSignal<string>()
  const currentNavMessage = createMemo(() => {
    const id = viewportMessageId()
    const messages: readonly TimelineNavTurn[] = props.navMessages ?? props.userMessages
    return messages.find((message) => message.id === id) ?? props.currentMessage ?? messages.at(-1)
  })
  const updateViewportMessage = (root: HTMLDivElement) => {
    const item = virtualizer.getVirtualItemForOffset(root.scrollTop + 100)
    const id = item ? timelineRows()[item.index]?.userMessageId : undefined
    if (id !== viewportMessageId()) setViewportMessageId(id)
  }

  createEffect(() => {
    props.setScrollToEnd?.(() => {
      prepend.clear()
      virtualizer.scrollToEnd()
    })
    props.setScrollToMessage?.((id, behavior) => {
      const root = listRoot()
      const index = messageRowIndex().get(id)
      if (!root || index === undefined) return false
      prepend.clear()
      virtualizer.getTotalSize()
      const offset = virtualizer.getOffsetForIndex(index, "start")
      if (!offset) return false
      const box = root.getBoundingClientRect()
      const inset = sessionMessageScrollInset({ rootTop: box.top, stickyBottom: box.top })
      virtualizer.scrollToOffset(Math.max(0, offset[0] - inset), { behavior })
      return true
    })
    props.setHistoryAnchor?.({ capture: prepend.capture, restore: prepend.restore, settle: prepend.settle })
  })

  let firstFoldRevealKey: string | undefined

  const scheduleFirstFoldReveal = () => {
    if (warmMeasurements || initialRevealReady() || timelineRows().length === 0) return
    const activationKey = host.sessionKey()
    if (firstFoldRevealKey === activationKey && cancelFirstFoldReveal) return
    cancelFirstFoldReveal?.()
    firstFoldRevealKey = activationKey
    cancelFirstFoldReveal = scheduleTimelineFirstFoldReveal({
      activationKey,
      currentActivationKey: host.sessionKey,
      prepare: () => {
        virtualizer.getTotalSize()
        const root = listRoot()
        const nativeAtEnd = root
          ? root.scrollHeight - root.clientHeight - root.scrollTop <= 1
          : false
        if (
          timelineInitialRevealShouldScroll({
            hasScrollGesture: props.hasScrollGesture(),
            shouldAnchorBottom: props.shouldAnchorBottom(),
          }) && !nativeAtEnd
        ) virtualizer.scrollToEnd()
      },
      reveal: () => {
        cancelFirstFoldReveal = undefined
        firstFoldRevealKey = undefined
        batch(() => {
          setProgressiveReady(true)
          setInitialRevealReady(true)
        })
      },
    })
  }

  createEffect(() => {
    const length = timelineRows().length
    if (length === 0 || initialRowsScheduled) return
    initialRowsScheduled = true
    if (warmMeasurements) return
    batch(() => {
      setInitialRevealReady(false)
      setProgressiveReady(false)
    })
    scheduleFirstFoldReveal()
  })

  onMount(() => {
    scheduleFirstFoldReveal()
  })

  let bottomAnchorSessionKey = ""
  let bottomAnchorFrame: number | undefined

  const maybeAnchorBottom = () => {
    const key = host.sessionKey()
    if (bottomAnchorSessionKey === key) return
    if (timelineRows().length === 0) return
    bottomAnchorSessionKey = key
    if (!props.shouldAnchorBottom()) return
    if (!initialRevealReady()) {
      scheduleFirstFoldReveal()
      return
    }
    if (bottomAnchorFrame !== undefined) cancelAnimationFrame(bottomAnchorFrame)
    prepend.clear()
    bottomAnchorFrame = requestAnimationFrame(() => {
      bottomAnchorFrame = undefined
      if (host.sessionKey() !== key) return
      const root = listRoot()
      if (!(root && root.scrollHeight - root.clientHeight - root.scrollTop <= 1)) virtualizer.scrollToEnd()
    })
  }

  let measuredSessionKey = host.sessionKey()
  createEffect(() => {
    const key = host.sessionKey()
    timelineRows()
    if (measuredSessionKey !== key) (measuredSessionKey = key), virtualizer.measure()
    maybeAnchorBottom()
  })

  onCleanup(() => {
    scrollMemory.capture()
    writeTimelineMountSnapshot(ownerSessionKey, { scroll: scrollMemory.snapshot(), measurements: virtualizer.takeSnapshot(), toolOpen: { ...toolOpen }, groupOpen: { ...groupOpen }, toolRevealed: { ...toolRevealed } })
    turnFold.persist()
    if (bottomAnchorFrame !== undefined) cancelAnimationFrame(bottomAnchorFrame)
    cancelFirstFoldReveal?.()
    resizeAnchor.dispose()
    props.setScrollToEnd?.(() => {})
    props.setScrollToMessage?.(undefined)
    props.setHistoryAnchor?.({ capture: () => {}, restore: () => {}, settle: () => {} })
  })

  const bindListRoot = (root: HTMLDivElement) => {
    if (root === listRoot()) return
    setListRoot(root)
    props.setScrollRef(root)
  }

  const listGestures = createTimelineListGestures({
    props,
    prepareInteractionScroll,
    prepend,
    updateViewportMessage,
    captureScroll: () => scrollMemory.capture(),
  })

  onCleanup(() => {
    props.setScrollRef(undefined)
  })

  createEffect(
    on(
      () => [parentId(), childTaskDescription()] as const,
      ([id, description]) => {
        if (!id || description) return
        if (parentMessages().length > 0) return
        void Promise.resolve(host.syncSession?.(id)).catch((error: unknown) => {
          console.warn("The parent session could not be read for a subagent's title", { sessionId: id, error })
        })
      },
      { defer: true },
    ),
  )

  const turnAssistantMessages = (userMessageId: string) =>
    assistantMessagesByParent().get(userMessageId) ?? emptyAssistantMessages
  const turnSettled = (userMessageId: string) => {
    const newest = turnAssistantMessages(userMessageId).at(-1)
    return !!newest && assistantMessageSettled(newest)
  }
  const workingTurn = (userMessageId: string) =>
    (sessionStatus().kind !== "idle" || turnSettleRefreshPending(userMessageId)) &&
    activeMessageId() === userMessageId &&
    !turnSettled(userMessageId)

  const turnDurationMs = (userMessageId: string) => {
    const message = messageById().get(userMessageId)
    if (!message || message.role !== "user") return undefined
    return Timeline.turnDurationMs(message, turnAssistantMessages(userMessageId))
  }

  const turnInterrupted = (userMessageId: string) =>
    Timeline.turnInterrupted(
      turnAssistantMessages(userMessageId),
      info()?.lastTurn,
    )

  const assistantCopyPartId = (userMessageId: string) => {
    if (workingTurn(userMessageId)) return null
    const all = assistantMessagesByParent().get(userMessageId) ?? emptyAssistantMessages
    const finalTurn = props.userMessages.at(-1)?.id === userMessageId
    const messages = initialTurnExpanded() || !finalTurn ? all : all.slice(-1)

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message) continue

      const parts = getMsgParts(message.id)
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j]
        if (!part || part.type !== "text" || sessionConversation()?.partsWithText[part.id] !== true) continue
        return part.id
      }
    }
    return undefined
  }

  const getMsgPart = (messageId: string, partId: string) => getMsgParts(messageId).find((part) => part.id === partId)
  const partOfRef = (ref: PartRef) => getMsgPart(ref.messageId, ref.partId)
  const runtimeMessage = (messageId: string) => {
    const message = messageById().get(messageId)
    return message && isRuntimeMessage(message) ? message : undefined
  }

  const renderAssistantPartGroup = (row: Accessor<TimelineRowMap["AssistantPart"]>, onSizeChange?: () => void) => {
    if (row().group.type === "context") {
      const members = createMemo(() => {
        const group = row().group
        return group.type === "context" ? Timeline.groupMembers(group.refs, runtimeMessage, partOfRef) : []
      })

      return (
        <ContextToolGroup
          parts={Timeline.memberTools(members())}
          open={groupOpen[row().group.key] ?? false}
          onOpenChange={(open) => {
            props.onReaderToggle()
            setGroupOpen(row().group.key, open)
          }}
          busy={
            !props.progressBlocked?.() && workingTurn(row().userMessageId) && lastAssistantGroupKey().get(row().userMessageId) === row().group.key
          }
          onSizeChange={onSizeChange}
        >
          <For each={members()}>
            {(member) => (
              <MessagePart
                part={member.part}
                message={member.message}
                turnDurationMs={turnDurationMs(row().userMessageId)}
                turnInterrupted={turnInterrupted(row().userMessageId)}
                toolOpen={toolOpen[member.part.id] ?? false}
                onToolOpenChange={(open) => toggleTool(member.part.id, open)}
                toolRevealed={toolRevealed[member.part.id] ?? false}
                onToolRevealedChange={(revealed) => revealToolOutput(member.part.id, revealed)}
                deferToolContent={false}
                virtualizeDiff
                onContentRendered={onSizeChange}
              />
            )}
          </For>
        </ContextToolGroup>
      )
    }

    if (row().group.type === "agents") {
      const members = createMemo(() => {
        const group = row().group
        if (group.type !== "agents") return []
        return group.refs
          .map((ref) => getMsgPart(ref.messageId, ref.partId))
          .filter((part): part is ToolPart => part?.type === "tool")
      })
      return <SubagentChipRow parts={members()} />
    }

    if (row().group.type === "work") {
      const members = createMemo(() => {
        const group = row().group
        return group.type === "work" ? Timeline.groupMembers(group.refs, runtimeMessage, partOfRef) : []
      })

      const memberDefaultOpen = (part: PartType) =>
        partDefaultOpen(part, host.settings.shellToolPartsExpanded(), host.settings.editToolPartsExpanded())
      const memberOpen = createMemo(() =>
        members().some(
          (member) => (toolOpen[member.part.id] ?? memberDefaultOpen(member.part)) || toolRevealed[member.part.id] === true,
        ),
      )

      return (
        <WorkGroup
          parts={Timeline.memberTools(members())}
          open={groupOpen[row().group.key] ?? false}
          onOpenChange={(open) => {
            props.onReaderToggle()
            setGroupOpen(row().group.key, open)
          }}
          busy={
            !props.progressBlocked?.() && workingTurn(row().userMessageId) && lastAssistantGroupKey().get(row().userMessageId) === row().group.key
          }
          memberOpen={memberOpen()}
          onSizeChange={onSizeChange}
        >
          <For each={members()}>
            {(member) => {
              const defaultOpen = createMemo(() => memberDefaultOpen(member.part))
              return (
                <MessagePart
                  part={member.part}
                  message={member.message}
                  turnDurationMs={turnDurationMs(row().userMessageId)}
                  turnInterrupted={turnInterrupted(row().userMessageId)}
                  defaultOpen={defaultOpen()}
                  toolOpen={toolOpen[member.part.id] ?? defaultOpen()}
                  onToolOpenChange={(open) => toggleTool(member.part.id, open)}
                  toolRevealed={toolRevealed[member.part.id] ?? false}
                  onToolRevealedChange={(revealed) => revealToolOutput(member.part.id, revealed)}
                  deferToolContent={false}
                  virtualizeDiff
                  onContentRendered={onSizeChange}
                />
              )
            }}
          </For>
        </WorkGroup>
      )
    }

    const message = createMemo(() => {
      const group = row().group
      return group.type === "part" ? runtimeMessage(group.ref.messageId) : undefined
    })
    const part = createMemo(() => {
      const group = row().group
      if (group.type !== "part") return undefined
      return getMsgPart(group.ref.messageId, group.ref.partId)
    })
    const defaultOpen = createMemo(() => {
      const item = part()
      if (!item) return undefined
      return partDefaultOpen(item, host.settings.shellToolPartsExpanded(), host.settings.editToolPartsExpanded())
    })

    return (
      <Show when={message()}>
        {(message) => (
          <Show when={part()}>
            {(part) => (
              <MessagePart
                part={part()}
                message={message()}
                showAssistantCopyPartId={assistantCopyPartId(row().userMessageId)}
                turnDurationMs={turnDurationMs(row().userMessageId)}
                turnInterrupted={turnInterrupted(row().userMessageId)}
                defaultOpen={defaultOpen()}
                toolOpen={toolOpen[part().id] ?? defaultOpen()}
                onToolOpenChange={(open) => toggleTool(part().id, open)}
                toolRevealed={toolRevealed[part().id] ?? false}
                onToolRevealedChange={(revealed) => revealToolOutput(part().id, revealed)}
                deferToolContent={false}
                virtualizeDiff
                onContentRendered={onSizeChange}
              />
            )}
          </Show>
        )}
      </Show>
    )
  }

  function TimelineRowFrame(input: { row: Accessor<FramedTimelineRow>; children: JSX.Element }) {
    const anchor = () => TimelineRow.anchorsMessage(input.row())
    const previousAssistantPart = () => {
      const row = input.row()
      return row._tag === "AssistantPart" && row.previousAssistantPart
    }
    return (
      <div
        id={anchor() ? props.anchor(input.row().userMessageId) : undefined}
        data-message-id={input.row().userMessageId}
        data-content-message-id={TimelineRow.contentMessageId(input.row())}
        data-content-part-id={TimelineRow.contentPartId(input.row())}
        data-timeline-row={input.row()._tag}
        classList={{
          "min-w-0 w-full max-w-full": true,
          "md:max-w-[var(--transcript-measure,48rem)] 2xl:max-w-[var(--transcript-measure,880px)]": props.centered,
          "md:mx-auto": props.centered,
        }}
        style={{ "padding-top": previousAssistantPart() ? "var(--transcript-part-gap, 12px)" : undefined }}
      >
        <div data-component="session-turn" class="min-w-0 w-full relative" style={{ height: "auto" }}>
          {input.children}
        </div>
      </div>
    )
  }

  const renderTimelineRow = (row: Accessor<TimelineRow.TimelineRow>, onSizeChange?: () => void) => {
    const current = row()
    switch (current._tag) {
      case "PreviousMessages": {
        const previousMessagesRow = rowOfTag(row, "PreviousMessages", current)
        return (
          <TimelineRowFrame row={previousMessagesRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <PreviousMessagesRow
                t={host.t}
                count={previousMessagesRow().count}
                onReveal={() => props.onRevealPreviousMessages?.()}
              />
            </div>
          </TimelineRowFrame>
        )
      }

      case "TurnGap":
        return <div data-timeline-row="TurnGap" aria-hidden="true" style={{ height: "var(--transcript-turn-gap, 24px)" }} />
      case "CommentStrip": {
        const commentStripRow = rowOfTag(row, "CommentStrip", current)
        const comments = createMemo(() =>
          getMsgParts(commentStripRow().userMessageId).flatMap((part) => MessageComment.fromPart(part) ?? []),
        )
        return (
          <TimelineRowFrame row={commentStripRow}>
            <div class="w-full px-4 md:px-5 pb-2">
              <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
                <div class="flex w-max min-w-full justify-end gap-2">
                  <Index each={comments()}>
                    {(comment) => <MessageCommentChip comment={comment()} t={host.t} />}
                  </Index>
                </div>
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "UserMessage": {
        const userMessageRow = rowOfTag(row, "UserMessage", current)
        const message = createMemo(() => {
          const m = messageById().get(userMessageRow().userMessageId)
          return m?.role === "user" ? m : undefined
        })
        return (
          <TimelineRowFrame row={userMessageRow}>
            <Show when={message()}>
              {(message) => (
                <TimelineUserMessage
                  message={message()}
                  parts={getMsgParts(userMessageRow().userMessageId)}
                  actions={isRuntimeMessage(message()) ? props.actions : undefined}
                />
              )}
            </Show>
          </TimelineRowFrame>
        )
      }
      case "TurnDivider": {
        const turnDividerRow = rowOfTag(row, "TurnDivider", current)
        const label = () => {
          if (turnDividerRow().label === "compaction") return host.t("ui.messagePart.compaction")
          if (turnDividerRow().label === "handoff") return `Session handed off to ${turnDividerRow().harness}`
          const durationMs = turnDividerRow().durationMs
          return typeof durationMs === "number"
            ? host.t("ui.message.interruptedDuration", { duration: formatDuration(durationMs) })
            : host.t("ui.message.interrupted")
        }
        return (
          <TimelineRowFrame row={turnDividerRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div data-slot="session-turn-compaction">
                <MessageDivider
                  label={label()}
                  icon={turnDividerRow().label === "compaction" ? "archive" : undefined}
                />
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "AssistantPart": {
        const assistantPartRow = rowOfTag(row, "AssistantPart", current)
        return (
          <TimelineRowFrame row={assistantPartRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div
                data-slot="session-turn-assistant-content"
                aria-hidden={workingTurn(assistantPartRow().userMessageId)}
              >
                <AssistantPartGroupView row={assistantPartRow} onSizeChange={onSizeChange} />
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "Thinking": {
        const thinkingRow = rowOfTag(row, "Thinking", current)
        return (
          <TimelineRowFrame row={thinkingRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineThinkingRow
                t={host.t}
                reasoningHeading={thinkingRow().reasoningHeading}
                showReasoningSummaries={host.settings.showReasoningSummaries()}
              />
            </div>
          </TimelineRowFrame>
        )
      }
      case "Retry": {
        const retryRow = rowOfTag(row, "Retry", current)
        return (
          <TimelineRowFrame row={retryRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <ClaxedoSessionRetry status={sessionStatus()} show={activeMessageId() === retryRow().userMessageId} />
            </div>
          </TimelineRowFrame>
        )
      }
      case "TurnFold": {
        const turnFoldRow = rowOfTag(row, "TurnFold", current)
        return (
          <TimelineRowFrame row={turnFoldRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TurnFoldRow
                durationMs={turnFoldRow().durationMs}
                folded={turnFoldRow().folded}
                tokens={turnFoldRow().tokens}
                cost={turnFoldRow().cost}
                showTokens={host.settings.timelineShowTurnTokens()}
                onToggle={() => {
                  props.onReaderToggle()
                  turnFold.setFolded(turnFoldRow().userMessageId, !turnFoldRow().folded)
                  onSizeChange?.()
                }}
              />
            </div>
          </TimelineRowFrame>
        )
      }
      case "DiffSummary": {
        const diffSummaryRow = rowOfTag(row, "DiffSummary", current)
        const undoTurn = () => {
          const revert = props.actions?.revert
          const id = sessionId()
          if (!revert || !id) return undefined
          return Promise.resolve(revert({ sessionId: id, messageId: diffSummaryRow().userMessageId }))
            .then(() => showToast({ title: host.t("ui.message.revertMessage") }))
            .catch((error: unknown) => {
              console.warn("The turn could not be undone", { error })
              showToast({ title: host.t("common.requestFailed"), variant: "error" })
            })
        }
        return (
          <TimelineRowFrame row={diffSummaryRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineDiffSummaryRow
                t={host.t}
                diffs={diffSummaryRow().diffs}
                onUndo={props.actions?.revert ? undoTurn : undefined}
              />
            </div>
          </TimelineRowFrame>
        )
      }
      case "Error": {
        const errorRow = rowOfTag(row, "Error", current)
        return (
          <TimelineRowFrame row={errorRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineErrorPresentation
                presentation={errorRow().presentation}
                recoveryClass={errorRow().recoveryClass}
                text={errorRow().text}
                summary={errorRow().summary}
                error={errorRow().error}
                providerId={errorRow().providerID}
                modelId={errorRow().modelID}
                onAction={(value) => props.onFirstTurnRecovery?.(value, errorRow().userMessageId)}
                t={host.t}
              />
            </div>
          </TimelineRowFrame>
        )
      }
    }
    return undefined
  }

  function AssistantPartGroupView(props: { row: Accessor<TimelineRowMap["AssistantPart"]>; onSizeChange?: () => void }) {
    return renderAssistantPartGroup(props.row, props.onSizeChange)
  }
  function TimelineRowView(props: { row: TimelineRow.TimelineRow; onSizeChange?: () => void }) {
    return renderTimelineRow(() => props.row, props.onSizeChange)
  }
  function VirtualTimelineRow(props: { rowKey: string }) {
    let element: HTMLDivElement | undefined
    const liveEntry = createMemo(() => timelineVirtualEntry({
      rowKey: props.rowKey,
      items: virtualItemByKey(),
      rows: timelineRowByKey(),
    }))
    const entry = createMemo<ReturnType<typeof liveEntry>>((previous) => liveEntry() ?? previous)
    const asyncFile = (value: TimelineRow.TimelineRow) => {
      if (value._tag !== "AssistantPart" || value.group.type !== "part") return false
      const part = getMsgPart(value.group.ref.messageId, value.group.ref.partId)
      return part?.type === "tool" && ["edit", "write", "apply_patch"].includes(part.tool)
    }
    const [contentReady, setContentReady] = createSignal(false)
    const ready = () => {
      const current = entry()
      return contentReady() || !!current && (current.item.size <= timelineFallbackItemSize || !asyncFile(current.row))
    }
    let contentMeasureFrame: number | undefined
    onCleanup(() => contentMeasureFrame !== undefined && cancelAnimationFrame(contentMeasureFrame))
    createEffect(on(() => entry()?.item.index, () => {
      if (element) virtualizer.measureElement(element)
    }, { defer: true }))

    return (
      <Show when={entry()}>
        {(current) => (
          <div
            data-timeline-key={props.rowKey}
            data-timeline-anchor={TimelineRow.anchorsReadingPosition(current().row) ? undefined : "none"}
            data-timeline-row-rich-ready={ready() ? "true" : "false"}
            style={{
              position: "absolute",
              top: `${current().item.start}px`,
              left: "0",
              width: "100%",
              height: `${current().item.size}px`,
              overflow: current().item.index === timelineRows().length - 1 ? "visible" : "clip",
              "overflow-clip-margin": current().row._tag === "TurnGap" ? undefined : "0.5px",
            }}
          >
            <div
              ref={(value) => {
                element = value
                value.dataset.index = String(current().item.index)
                virtualizer.measureElement(value)
              }}
              data-index={current().item.index}
              style={timelineRowFrameStyle({
                minHeight: ready() ? undefined : current().item.size,
              })}
            >
              <TimelineRowView
                row={current().row}
                onSizeChange={() => {
                  setContentReady(true)
                  if (contentMeasureFrame !== undefined) cancelAnimationFrame(contentMeasureFrame)
                  if (element) contentMeasureFrame = scheduleConnectedMeasure(element, (el) => virtualizer.measureElement(el))
                }}
              />
            </div>
          </div>
        )}
      </Show>
    )
  }

  return (
    <div
      class="relative w-full h-full min-w-0"
      ref={registerTimelineRoot}
      data-session-timeline-root
      data-session-timeline-session-id={sessionId() ?? ""}
      data-session-timeline-user-count={String(props.userMessages.length)}
      data-session-timeline-row-count={String(timelineRows().length)}
      data-session-timeline-key-count={String(virtualRowKeys().length)}
      data-session-timeline-reveal-ready={initialRevealReady() ? "true" : "false"}
      data-session-timeline-progressive-ready={progressiveReady() ? "true" : "false"}
      data-session-timeline-nav-gutter={messageNavGutterVisible() ? "" : undefined}
      style={{ visibility: timelineInitialRevealVisibility({ ready: initialRevealReady() }) }}
      onClick={handleTimelinePathClick}
      onContextMenu={fileMenu.open}
    >
      <Show when={fileMenu.menu()}>
        {(menu) => (
          <TimelineFileContextMenu
            menu={menu()}
            onOpenFile={links.openFile}
            onOpenExternal={host.platform.openPath ? links.openFileExternally : undefined}
            onDismiss={fileMenu.dismiss}
            resolvePath={(path) => resolveTimelineFilePath(path, host.placementPath)}
          />
        )}
      </Show>
      <Show when={messageNavMountReady() && messageNavGutterVisible()}>
        <div class="pointer-events-none absolute inset-0 z-[45]">
          <MessageNav
            class="pointer-events-auto absolute left-2 md:left-3 top-1/2 -translate-y-1/2"
            messages={props.navMessages ?? props.userMessages}
            current={currentNavMessage()}
            size="compact"
            onMessageSelect={props.onMessageSelect!}
            getPreview={turnPreview}
          />
        </div>
      </Show>
      <TimelineJumpButton
        shown={props.scroll.overflow && props.scroll.jump}
        working={sessionStatus().kind === "working"}
        label={host.t("session.timeline.scrollToBottom")}
        onClick={props.onResumeScroll}
      />
      <ScrollView
        data-slot="session-timeline-scroll"
        viewportRef={bindListRoot}
        onWheel={listGestures.onWheel}
        onTouchStart={listGestures.onTouchStart}
        onTouchMove={listGestures.onTouchMove}
        onTouchEnd={listGestures.onTouchEnd}
        onTouchCancel={listGestures.onTouchEnd}
        onPointerDown={listGestures.onPointerDown}
        onPointerMove={listGestures.onPointerMove}
        onScroll={listGestures.onScroll}
        class="relative min-w-0 w-full h-full"
        style={transcriptStyle()}
      >
        <div data-timeline-bottom-anchor aria-hidden="true" class="flex-1" />
        <Show when={parentId()}>
          <h1 data-subagent-child-heading tabIndex={-1} class="sr-only">
            {childTitle()}
          </h1>
        </Show>
        <Show when={ambientSubagents().length > 0}>
          <section
            aria-labelledby="background-subagents-heading"
            class="w-full px-4 pb-4 md:max-w-[var(--transcript-measure,48rem)] md:mx-auto 2xl:max-w-[var(--transcript-measure,880px)]"
          >
            <h2 id="background-subagents-heading" class="pb-2 text-12-medium text-text-weak">
              Background subagents
            </h2>
            <SubagentChipRow subagents={ambientSubagents()} />
          </section>
        </Show>
        <div data-timeline-content ref={props.setContentRef} class="w-full shrink-0">
          <div
            data-timeline-virtual-content
            ref={(element) => {
              virtualContent = element
            }}
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: "relative",
              width: "100%",
            }}
          >
            <For each={virtualRowKeys()}>{(rowKey) => <VirtualTimelineRow rowKey={rowKey} />}</For>
            <Show when={timelineRows().length > 0}>
              <div
                data-timeline-row="bottom-spacer"
                aria-hidden="true"
                class="pointer-events-none h-16 absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${virtualizer.getTotalSize() - 64}px)` }}
              />
            </Show>
          </div>
          <TimelineBackgroundWork work={host.backgroundWork()} t={host.t} tucked={timelineRows().length > 0} />
          <Show when={props.queued}>
            {(queued) => (
              <div class="relative" classList={{ "-mt-10": timelineRows().length > 0 && !backgroundWorkActive(host.backgroundWork()) && (queuedNotYetInTranscript().length > 0 || queued().loadFailed()) }}>
                <TimelineQueuedMessages queued={queued()} items={queuedNotYetInTranscript} centered={props.centered} t={host.t} />
              </div>
            )}
          </Show>
        </div>
      </ScrollView>
    </div>
  )
}
