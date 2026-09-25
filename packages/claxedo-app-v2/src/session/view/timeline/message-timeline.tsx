import { asRecord, readString } from "@/lib/record"
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
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { createVirtualizer, defaultRangeExtractor, elementScroll } from "@tanstack/solid-virtual"
import { observeElementOffsetReconnectAware, observeElementRectDeduped } from "./message-timeline-observe-offset"
import {
  assistantMessageSettled,
  ContextToolGroup,
  isSubagentToolPart,
  MessageNav,
  MessageDivider,
  Part as MessagePart,
  partDefaultOpen,
  SubagentChipRow,
  TurnFoldRow,
  WorkGroup,
} from "@/transcript"
import { isPhoneWidth } from "@/lib/viewport"
import { ClaxedoIcon as Icon, FileIcon, ScrollView, resolveTranscriptTypography, transcriptTypographyStyle, showToast, Binary, getFilename } from "@/ui"
import { ClaxedoSessionRetry } from "./claxedo-session-retry"
import { TimelineErrorPresentation } from "./first-turn-recovery-card"
import { TimelineQueuedMessages } from "./timeline-queued-messages"
import type {
  AgentAssistantMessage as AssistantMessage,
  AgentContentPart as PartType,
  AgentPresentationMessage as MessageType,
  AgentToolPart as ToolPart,
} from "@claxedo/agent-runtime-contract"
import { createTimelineListGestures } from "./message-timeline-list-gestures"
import { useData } from "@/transcript"
import { sessionTitle } from "./session-title"
import { latchSessionTitle, type LatchedSessionTitle } from "./session-title-latch"
import { createActivePaneProjection } from "./active-pane-projection"
import { MessageComment, Timeline } from "./message-timeline.data"
import { ImageMarkBadge } from "@/lib/image-mark-badge"
import { TimelineRow, type TimelineRowMap } from "./timeline-row-model"
import { PreviousMessagesRow, TimelineDiffSummaryRow, TimelineLoadingRow, TimelineThinkingRow } from "./message-timeline-turn-rows"
import { nextThinkingVisibilityHold } from "./thinking-visibility-hold"
import { TimelineFileContextMenu } from "./timeline-file-context-menu"
import { isRuntimeMessage } from "@/transcript"
import {
  timelineInitialRevealShouldScroll,
  timelineInitialRevealVisibility,
  timelineInteractionPlan,
  timelineVirtualEntry,
} from "./timeline-view-state"
import { createTimelinePrependAnchor } from "./timeline-prepend-anchor"
import {
  createTimelineResizeAnchor,
  estimateTimelineRowSize,
  filterVirtualIndexes,
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
import { subagentHostCallIds } from "./subagent-parts"
import type { TranscriptUserMessage as UserMessage } from "@/transcript"
import { TimelineUserMessage } from "./timeline-user-message"
import {
  timelineAnchorClickTarget,
  timelineExternalSourceClickTarget,
  timelineFileCandidateIsOpenable,
  timelineFileFocus,
  timelineFileTarget,
  resolveTimelinePath as resolveTimelineFilePath,
} from "./timeline-file-paths"
import { createTimelineLinkOpen } from "./timeline-link-open"
import { createMessageNavRoom } from "./message-nav-layout"
import { messageNavCurrentID, messageNavPreview, messageNavVisible } from "./message-nav-preview"
import { createMessageNavDeferredMount } from "./message-nav-deferred-mount"
import { scheduleTimelineFirstFoldReveal } from "./timeline-first-fold-reveal"
import type { MessageTimelineProps } from "./message-timeline-props"
import type { ConversationMessage } from "@/transcript"
import { turnActive, type TimelineSessionRow } from "./model"
import "./message-nav-gutter.css"
import "./markdown-surfaces.css"

// Keep parity with the upstream session row model.
const emptyMessages: ConversationMessage[] = []
const emptyParts: PartType[] = []
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

/**
 * A tag-narrowed view of the row accessor, seeded with the row the switch
 * already narrowed.
 *
 * `switch (row()._tag)` narrows the row VALUE, not the accessor, so each branch
 * used to re-assert the accessor's type. A row slot can also be reused for a
 * different tag for the tick before Solid disposes the branch; latching the last
 * matching row keeps the disposing branch reading its own fields instead of
 * silently reading another tag's shape through the asserted type.
 */
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

const taskDescription = (part: PartType, sessionID: string) => {
  if (part.type !== "tool" || !isSubagentToolPart(part)) return undefined
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  if (metadata?.sessionId !== sessionID) return undefined
  const value = part.state.input?.description
  if (typeof value === "string" && value) return value
  return undefined
}

export function MessageTimeline(props: MessageTimelineProps) {
  const host = props.host
  const data = useData()
  const transcriptStyle = createMemo(() => transcriptTypographyStyle(resolveTranscriptTypography(host.transcriptTypography())))
  const ownerSessionKey = host.sessionKey()
  const cached = readTimelineMountSnapshot(ownerSessionKey, host.seededTurnFoldableCounts)
  const savedScroll = cached?.scroll
  if (savedScroll && !props.hasScrollTarget()) props.restoreFollowing(savedScroll.following)
  const initialMeasurements = cached?.measurements
  const warmMeasurements = !!initialMeasurements?.length
  const boundColdFinalTurn = !warmMeasurements && host.status().kind === "idle"
  const [initialTurnExpanded, setInitialTurnExpanded] = createSignal(!boundColdFinalTurn)
  const turnFold = createTurnFoldStore(ownerSessionKey)
  const [toolOpen, setToolOpen] = createStore<Record<string, boolean | undefined>>(cached?.toolOpen ?? {})
  const [groupOpen, setGroupOpen] = createStore<Record<string, boolean | undefined>>(cached?.groupOpen ?? {})
  const [toolRevealed, setToolRevealed] = createStore<Record<string, boolean | undefined>>(cached?.toolRevealed ?? {})
  const revealToolOutput = (partID: string, revealed: boolean) => {
    // A reveal click resizes the row at the reader's position; the gesture mark
    // keeps the resize anchor from bottom-pinning the growth.
    props.onMarkScrollGesture()
    setToolRevealed(partID, revealed)
  }
  installTimelineMermaid(host.platform.renderMermaid)
  installTimelineTables()

  // A subagent's transcript is a workspace-panel tab, not a second pane: splitting took the turn the reader was on down to half width.
  // Below the md boundary the panel covers that turn rather than sitting beside it, so there the child takes the pane instead.
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

  // Shared with the terminal's file links (timeline-file-paths.ts):
  // normalizes/relativizes, parses `:line[:col]`, refuses `~`/traversal/
  // out-of-workspace paths, which would open blank tabs.
  const fileFocus = (raw: string) => timelineFileFocus(raw, host.placementPath)

  // Open a file in the workspace side panel (same path terminal file links take
  // via terminal-content.tsx `onFileLinkOpen`), NOT `platform.openPath` (which
  // is desktop-only and hands the file to the OS). No `navigator: "files"` — it
  // would slide the tree drawer over the file tab this click just opened.
  const openFileInPanel = (raw: string) => {
    const target = fileFocus(raw)
    if (!target) return
    host.openFocus({ kind: "file", path: target.path, line: target.line, col: target.col })
  }

  // Path-kind inline-code chips in assistant markdown. Anchors are handled in
  // the capture phase below so preventDefault beats the native target="_blank"
  // window; in Electron a bubble-phase handler opened the link in both a
  // browser and the panel.
  let candidateFileController: AbortController | undefined
  onCleanup(() => candidateFileController?.abort())
  createEffect(() => {
    if (!props.active()) candidateFileController?.abort()
  })
  const handleTimelinePathClick = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    const target = event.target instanceof Element ? event.target : null
    const selection = typeof window !== "undefined" ? window.getSelection() : null
    if (selection && !selection.isCollapsed) return // don't hijack a text-selection click
    if (target?.closest("a[href]")) return // anchors → capture handler below
    const chip = target?.closest<HTMLElement>('[data-inline-code-kind="path"], [data-inline-code-kind="path-candidate"]')
    const raw = chip?.textContent?.trim()
    if (!raw || !fileFocus(raw)) return
    event.preventDefault()
    if (chip?.dataset.inlineCodeKind === "path") {
      openFileInPanel(raw)
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
      openFileInPanel(raw)
    })
  }
  // Capture phase runs before the link's default action (see above).
  const [timelineRoot, setTimelineRoot] = createSignal<HTMLDivElement>()
  const messageNavHasRoom = createMessageNavRoom(timelineRoot)
  // One memo drives BOTH the rail's mount and `data-session-timeline-nav-gutter`
  // on the root, so message-nav-gutter.css reserves the gutter without a `:has()`
  // anchor over the timeline — see that file for why the anchor was expensive.
  const messageNavGutterVisible = createMemo(() =>
    messageNavVisible((props.navMessages ?? props.userMessages).length) && messageNavHasRoom() && !!props.onMessageSelect,
  )

  const links = createTimelineLinkOpen({ openFocus: host.openFocus, platform: host.platform })

  const registerTimelineRoot = (el: HTMLDivElement) => {
    setTimelineRoot(el)
    const stopLinkOpen = links.listen(el)
    const onOpenSubagent = (event: Event) => {
      // The detail rides on a DOM CustomEvent, so it is read structurally rather
      // than asserted into a typed CustomEvent the listener never guaranteed.
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
    const onCapture = (event: MouseEvent) => {
      const externalSourceUrl = timelineExternalSourceClickTarget(event)
      if (externalSourceUrl) {
        event.preventDefault()
        event.stopImmediatePropagation()
        links.openBrowserTab(externalSourceUrl)
        return
      }
      const raw = timelineAnchorClickTarget(event)
      if (!raw || !fileFocus(raw)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      openFileInPanel(raw)
    }
    el.addEventListener("click", onCapture, { capture: true })
    onCleanup(() => {
      stopLinkOpen()
      el.removeEventListener("claxedo:open-subagent", onOpenSubagent)
      el.removeEventListener("claxedo:open-plan", onOpenPlan)
      el.removeEventListener("click", onCapture, { capture: true })
    })
  }

  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; path: string } | undefined>()
  const handleTimelineContextMenu = (event: MouseEvent) => {
    const raw = timelineFileTarget(event.target)
    if (!raw) return
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY, path: raw })
  }

  const [listRoot, setListRoot] = createSignal<HTMLDivElement>()
  const sessionID = createMemo(() => host.sessionId())
  const sessionConversation = host.conversation
  const sessionMessages = createMemo(() => sessionConversation()?.messages ?? emptyMessages)
  const messageByID = createMemo(() => new Map(sessionMessages().map((message) => [message.id, message] as const)))
  // An admitted prompt reaches the transcript over events before the next
  // queue poll drops its record; the record carries the id the turn's user
  // message gets, so the bubble yields to the row the moment the row exists.
  const queuedNotYetInTranscript = createMemo(() =>
    (props.queued?.items() ?? []).filter((item) => !item.messageId || !messageByID().has(item.messageId)),
  )
  // Both indexes are keyed by, and answer questions about, the parent/completion
  // fields only a runtime-produced assistant message has. An optimistic row has
  // no `parentID` to file it under and no `time.completed` to be pending on, so
  // it is excluded here rather than filed under `undefined` and looked up by no
  // one (every read below passes a real message id).
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
  const sessionStatus = createActivePaneProjection({ active: props.active, read: () => host.status() ?? idle, initial: idle })
  // A `session.idle` lands before the final transcript read does: the turn's
  // assistant row is still unsettled and its reply not yet painted. While the
  // post-acceptance reconciliation owns that read, the turn is still working —
  // dropping the Thinking row on the event alone blanked the tail of the turn
  // until the snapshot arrived. The request clears only after the reconciled
  // conversation is in the store, so no frame shows neither indicator.
  const turnSettleRefreshPending = (userMessageID: string) => host.turnSettlePending(userMessageID)
  const working = createMemo(() => turnActive(sessionStatus()))
  const directorySessionRows = createActivePaneProjection({ active: props.active, read: host.sessions, initial: [] as readonly TimelineSessionRow[] })
  const directorySession = (sessionID: string | undefined) =>
    sessionID ? directorySessionRows().find((session) => session.id === sessionID) : undefined
  const hostCallIds = createMemo(() => subagentHostCallIds(sessionConversation()?.parts ?? {}))
  const resolveAmbientSubagents = () => {
    const id = sessionID()
    if (!id) return []
    return (data.resolveSubagents?.(id, undefined, hostCallIds()) ?? []).filter((subagent) => subagent.ambient)
  }
  const ambientSubagents = createActivePaneProjection({
    active: props.active,
    read: resolveAmbientSubagents,
    initial: [] as ReturnType<typeof resolveAmbientSubagents>,
  })

  const activeMessageID = createMemo(() => {
    const messages = sessionMessages()
    let lastUserIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") { lastUserIndex = i; break }
    }
    const parentID = pending()?.parentID
    if (parentID) {
      const result = Binary.search(messages, parentID, (message) => message.id)
      const index = result.found ? result.index : messages.findIndex((item) => item.id === parentID)
      const message = index >= 0 ? messages[index] : undefined
      // A stale un-completed assistant anchors on its parent only while that
      // parent is still the newest prompt — once a follow-up send lands, the
      // new user message owns the turn even if the old envelope's completion
      // frame is still in flight.
      if (message && message.role === "user" && index >= lastUserIndex) return message.id
    }

    if (lastUserIndex < 0) return undefined
    const newest = messages[lastUserIndex].id
    // An idle that lands before the turn's transcript read keeps the newest
    // turn active: its reply is still owed, and letting go of it here drops
    // the Thinking row with nothing to take its place.
    if (sessionStatus().kind !== "idle" || turnSettleRefreshPending(newest)) return newest
    return undefined
  })
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return undefined
    return directorySession(id)
  })
  const titleSource = createActivePaneProjection<string | undefined>({ active: props.active, read: props.title, initial: undefined })
  const latchedTitle = createMemo<LatchedSessionTitle | undefined>((previous) => latchSessionTitle(previous, { sessionKey: host.sessionKey(), title: titleSource() }))
  const titleLabel = createMemo(() => sessionTitle(latchedTitle()?.title))
  const parentID = createMemo(() => props.parentId)
  const parentConversation = host.parentConversation
  const parentMessages = createMemo(() => parentConversation()?.messages ?? emptyMessages)
  const getMsgParts = (msgId: string) => sessionConversation()?.parts[msgId] ?? emptyParts
  const getParentMsgParts = (msgId: string) => parentConversation()?.parts[msgId] ?? emptyParts
  const turnPreview = (message: UserMessage) =>
    messageNavPreview({
      userMessageID: message.id,
      assistantMessageIDs: (assistantMessagesByParent().get(message.id) ?? emptyAssistantMessages).map(
        (item) => item.id,
      ),
      getParts: getMsgParts,
    })
  const childTaskDescription = createMemo(() => {
    const id = sessionID()
    if (!id) return undefined
    return parentMessages()
      .flatMap((message) => getParentMsgParts(message.id))
      .map((part) => taskDescription(part, id))
      .findLast((value): value is string => !!value)
  })
  const childTitle = createMemo(() => {
    if (!parentID()) return titleLabel() ?? ""
    if (childTaskDescription()) return childTaskDescription()
    const value = titleLabel()?.replace(/\s+\(@[^)]+ subagent\)$/, "")
    if (value) return value
    return host.t("command.session.new")
  })

  // Per-message inputs are equality-gated so a streaming part event (which
  // produces a new conversation snapshot + a new assistantMessagesByParent Map
  // every tick) only re-runs constructMessageRows for the message whose parts
  // actually changed. Message and Part[] identities are stable for unchanged
  // messages (see agentConversationProjection's WeakMap cache), so the cheap
  // identity comparisons below turn wholesale per-tick recomputation into
  // O(changed turn) work.
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
          () => {
            const conversation = sessionConversation()
            const parts: Record<string, PartType[]> = {
              [userMessage.id]: conversation?.parts[userMessage.id] ?? emptyParts,
            }
            for (const message of turnAssistants()) {
              parts[message.id] = conversation?.parts[message.id] ?? emptyParts
            }
            return parts
          },
          undefined,
          { equals: samePartsRecord },
        )
        const visibleAssistantMessageIDs = createMemo(() => {
          if (initialTurnExpanded() || indexAccessor() !== props.userMessages.length - 1) return undefined
          const parts = turnParts()
          return Timeline.coldFinalVisibleAssistantMessageIDs(
            turnAssistants(),
            (messageID) => parts[messageID] ?? emptyParts,
          )
        })
        const isActive = createMemo(() => activeMessageID() === userMessage.id)
        return createMemo((previous: TimelineRow.TimelineRow[] | undefined) => {
          const parts = turnParts()
          const shownFoldCount = previous?.find((row): row is TimelineRow.TurnFold => row._tag === "TurnFold")?.foldCount
          const rows = Timeline.constructMessageRows(
            userMessage,
            (messageID) => parts[messageID] ?? emptyParts,
            turnAssistants(),
            indexAccessor(),
            host.settings.showReasoningSummaries(),
            statusType(),
            isActive(),
            props.firstTurnRecovery !== false && indexAccessor() === 0,
            (userMessageID) => turnFold.isFolded(userMessageID),
            lastTurnOutcome(),
            visibleAssistantMessageIDs(),
            (userMessageID) => Math.max(cached?.turnFoldableCounts?.[userMessageID] ?? 0, shownFoldCount ?? 0) || undefined,
            (partID) => toolOpen[partID] === true || toolRevealed[partID] === true,
            turnSettleRefreshPending(userMessage.id),
            (messageID) => sessionConversation()?.fragmentParts.has(messageID) === true,
          )

          return TimelineRow.reuse(previous, rows)
        })
      },
    ),
  )

  // Status can blip off "busy" for a frame mid-stream; dropping Thinking then
  // collapses the virtualizer. Hold the last Thinking row for a short hide delay.
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
    return TimelineRow.PreviousMessages({ userMessageID: head.id, count })
  }

  const timelineRows = createMemo((previous: TimelineRow.TimelineRow[] | undefined) => {
    thinkingHoldRevision()
    const rows = messageRowMemos().flatMap((memo) => memo())
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
  })

  const prepend = createTimelinePrependAnchor({
    root: listRoot, displayed: props.active,
    resolveRowStart: (key) => {
      const index = timelineRows().findIndex((row) => TimelineRow.key(row) === key)
      return index < 0 ? undefined : virtualizer.getOffsetForIndex(index, "start")?.[0]
    },
  })
  onCleanup(prepend.clear)
  const initialRowCount = timelineRows().length
  const [renderOverscan, setRenderOverscan] = createSignal(initialMeasurements?.length ? 6 : 1)
  const [initialRevealReady, setInitialRevealReady] = createSignal(warmMeasurements || initialRowCount === 0)
  const [progressiveReady, setProgressiveReady] = createSignal(warmMeasurements || initialRowCount === 0)
  const messageNavMountReady = createMessageNavDeferredMount(props.active, initialRevealReady, messageNavGutterVisible)
  let initialRowsScheduled = initialRowCount > 0
  let cancelFirstFoldReveal: (() => void) | undefined
  const prepareScrollOverscan = () => {
    if (!initialTurnExpanded()) setInitialTurnExpanded(true)
    if (renderOverscan() < 6) setRenderOverscan(6) // 6 rows: a flick leaves 0 blank px at 1400px/frame and 802 at 5600, where 12 rows still leaves 443 and takes the worst renderer task from 16ms to 31ms (perf-harness transcript-flick)
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
  // Opening at the end and staying at the end are different promises. The
  // first is `shouldAnchorBottom`: a session opens on its latest turn. The
  // second holds only while a turn streams: for a settled transcript, a size
  // change is the reader opening a fold or a tool row, and re-pinning the
  // viewport to the new end — by the row's estimated height, before it is
  // measured — takes them from what they clicked to the bottom of the page.
  const followsEnd = () => props.shouldAnchorBottom() && working()
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return timelineRows().length
    },
    getScrollElement: () => listRoot() ?? null,
    observeElementRect: observeElementRectDeduped,
    observeElementOffset: observeElementOffsetReconnectAware,
    initialRect: {
      width: typeof window === "undefined" ? 0 : window.innerWidth,
      height: typeof window === "undefined" ? 0 : window.innerHeight,
    },
    initialOffset: () => props.shouldAnchorBottom() ? Number.MAX_SAFE_INTEGER : (savedScroll?.offset ?? 0),
    initialMeasurementsCache: initialMeasurements,
    estimateSize: (index) => estimateTimelineRowSize({ index, rows: timelineRows(), parts: getMsgParts }),
    scrollToFn: (offset, options, instance) => {
      if (virtualContent) virtualContent.style.height = `${instance.getTotalSize()}px`
      elementScroll(offset, options, instance)
    },
    get getItemKey() {
      const keys = timelineRows().map(TimelineRow.key)
      resizeAnchor.noteRowKeys(keys)
      return (index: number) => keys[index] ?? `removed:${index}`
    },
    get anchorTo() {
      return followsEnd() ? "end" : "start"
    },
    get followOnAppend() {
      return props.active() && followsEnd() && !resizeAnchor.held()
    },
    // In-view insert holds and gesture windows mean the reader owns the viewport.
    get scrollEndThreshold() {
      return resizeAnchor.held() || props.hasScrollGesture() ? -1 : 80
    },
    get overscan() { return renderOverscan() },
    paddingEnd: 64,
    // A getter, not a stable closure: the virtualizer memoizes the extractor's
    // output keyed on the extractor's IDENTITY plus the computed range/count
    // (virtual-core getVirtualIndexes deps). Solid signals read while the
    // extractor RUNS are invisible to that memo, so a stable closure serves
    // stale indexes whenever only those signals change (a stale extractor
    // once left the timeline mounting one row forever after a reload).
    // Reading them here — at option-read time inside the adapter's tracked
    // setOptions pass — subscribes the virtualizer and mints a new identity.
    get rangeExtractor() {
      const rows = timelineRows()
      const activeID = activeMessageID()
      const overscan = renderOverscan()
      const pinned = resizeAnchor.pinnedIndexes()
      return (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
        const active = activeID
          ? rows.findLastIndex((row) => "userMessageID" in row && row.userMessageID === activeID)
          : -1
        return filterVirtualIndexes(
          [...new Set([...pinned, ...defaultRangeExtractor({ ...range, overscan }), ...(active < 0 ? [] : [active])])]
            .sort((a, b) => a - b),
          range.count,
        )
      }
    },
  })
  resizeAnchor.install({
    virtualizer,
    root: listRoot,
    displayed: props.active,
    shouldAnchorBottom: followsEnd,
    hasScrollGesture: props.hasScrollGesture,
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
  // The prepend-anchor loop parks itself while stashed (it reads
  // `props.active`). Returning needs the nudge: a parked loop has no frame on
  // which to notice that its surface came back.
  createEffect(() => {
    if (props.active()) prepend.resume()
  })
  const timelineRowByKey = createMemo(() => new Map(timelineRows().map((row) => [TimelineRow.key(row), row] as const)))
  const virtualItemByKey = createMemo(
    () => new Map(virtualizer.getVirtualItems().map((item) => [String(item.key), item] as const)),
  )
  const virtualRowKeys = createMemo(() => virtualizer.getVirtualItems().map((item) => String(item.key)))
  const messageRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    timelineRows().forEach((row, index) => {
      if (!TimelineRow.anchorsMessage(row)) return
      result.set(row.userMessageID, index)
    })
    return result
  })
  const lastAssistantGroupKey = createMemo(() => {
    const result = new Map<string, string>()
    timelineRows().forEach((row) => {
      if (row._tag !== "AssistantPart") return
      result.set(row.userMessageID, row.group.key)
    })
    return result
  })
  const [viewportMessageID, setViewportMessageID] = createSignal<string>()
  const currentNavMessage = createMemo(() => {
    const id = viewportMessageID()
    const messages = props.navMessages ?? props.userMessages
    return messages.find((message) => message.id === id) ?? props.currentMessage ?? messages.at(-1)
  })
  const updateViewportMessage = (root: HTMLDivElement) => {
    const id = messageNavCurrentID(
      virtualizer.getVirtualItems().flatMap((item) => {
        const row = timelineRows()[item.index]
        return row && "userMessageID" in row ? [{ id: row.userMessageID, start: item.start }] : []
      }),
      root.scrollTop + 100,
    )
    if (id !== viewportMessageID()) setViewportMessageID(id)
  }

  createEffect(() => {
    props.setScrollToEnd?.(() => virtualizer.scrollToEnd())
    props.setScrollToMessage?.((id, behavior) => {
      const root = listRoot()
      const index = messageRowIndex().get(id)
      if (!root || index === undefined) return false
      // getOffsetForIndex reads a lazily-refreshed cache; refresh it first.
      virtualizer.getTotalSize()
      const offset = virtualizer.getOffsetForIndex(index, "start")
      if (!offset) return false
      const box = root.getBoundingClientRect()
      const inset = sessionMessageScrollInset({ rootTop: box.top, stickyBottom: box.top })
      virtualizer.scrollToOffset(Math.max(0, offset[0] - inset), { behavior })
      return true
    })
    props.setHistoryAnchor?.({ capture: prepend.capture, restore: prepend.restore })
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
        // Force the capped fold's virtual measurements while the surface is
        // still hidden, then perform the bottom-anchor write before paint.
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

  let measuredSessionKey = host.sessionKey(), renderedRows: TimelineRow.TimelineRow[] = []
  createEffect(() => {
    const key = host.sessionKey()
    renderedRows = timelineRows()
    if (measuredSessionKey !== key) (measuredSessionKey = key), virtualizer.measure()
    maybeAnchorBottom()
  })

  onCleanup(() => {
    scrollMemory.capture()
    writeTimelineMountSnapshot(ownerSessionKey, { scroll: scrollMemory.snapshot(), measurements: virtualizer.takeSnapshot(), toolOpen: { ...toolOpen }, groupOpen: { ...groupOpen }, toolRevealed: { ...toolRevealed }, rows: renderedRows })
    turnFold.persist()
    if (bottomAnchorFrame !== undefined) cancelAnimationFrame(bottomAnchorFrame)
    cancelFirstFoldReveal?.()
    resizeAnchor.dispose()
    props.setScrollToEnd?.(() => {})
    props.setScrollToMessage?.(undefined)
    props.setHistoryAnchor?.({ capture: () => {}, restore: () => {} })
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
      () => [parentID(), childTaskDescription()] as const,
      ([id, description]) => {
        if (!id || description) return
        if (parentMessages().length > 0) return
        void Promise.resolve(host.syncSession?.(id)).catch(() => undefined)
      },
      { defer: true },
    ),
  )

  const turnAssistantMessages = (userMessageID: string) =>
    assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages
  // The newest message says whether the turn is open: a step-per-message
  // harness completes each earlier step while the next one is still streaming.
  const turnSettled = (userMessageID: string) => {
    const newest = turnAssistantMessages(userMessageID).at(-1)
    return !!newest && assistantMessageSettled(newest)
  }
  const workingTurn = (userMessageID: string) =>
    (sessionStatus().kind !== "idle" || turnSettleRefreshPending(userMessageID)) &&
    activeMessageID() === userMessageID &&
    !turnSettled(userMessageID)

  const turnDurationMs = (userMessageID: string) => {
    const message = messageByID().get(userMessageID)
    if (!message || message.role !== "user") return undefined
    return Timeline.turnDurationMs(message, turnAssistantMessages(userMessageID))
  }

  const turnInterrupted = (userMessageID: string) =>
    Timeline.turnInterrupted(
      turnAssistantMessages(userMessageID),
      info()?.lastTurn,
    )

  const assistantCopyPartID = (userMessageID: string) => {
    if (workingTurn(userMessageID)) return null
    const all = assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages
    const finalTurn = props.userMessages.at(-1)?.id === userMessageID
    const messages = initialTurnExpanded() || !finalTurn ? all : all.slice(-1)

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message) continue

      const parts = getMsgParts(message.id)
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j]
        if (!part || part.type !== "text" || !part.text?.trim()) continue
        return part.id
      }
    }
    return undefined
  }

  const getMsgPart = (messageID: string, partID: string) => getMsgParts(messageID).find((part) => part.id === partID)

  const renderAssistantPartGroup = (row: Accessor<TimelineRowMap["AssistantPart"]>, onSizeChange?: () => void) => {
    if (row().group.type === "context") {
      const members = createMemo(() => {
        const group = row().group
        if (group.type !== "context") return []
        return group.refs
          .map((ref) => {
            const message = messageByID().get(ref.messageID)
            const part = getMsgPart(ref.messageID, ref.partID)
            if (!message || !isRuntimeMessage(message)) return undefined
            if (!part || part.type !== "tool") return undefined
            return { message, part }
          })
          .filter((member): member is { message: MessageType; part: ToolPart } => !!member)
      })

      return (
        <ContextToolGroup
          parts={members().map((member) => member.part)}
          open={groupOpen[row().group.key] ?? false}
          onOpenChange={(open) => setGroupOpen(row().group.key, open)}
          busy={
            !props.progressBlocked?.() && workingTurn(row().userMessageID) && lastAssistantGroupKey().get(row().userMessageID) === row().group.key
          }
          onSizeChange={onSizeChange}
        >
          <For each={members()}>
            {(member) => (
              <MessagePart
                part={member.part}
                message={member.message}
                turnDurationMs={turnDurationMs(row().userMessageID)}
                turnInterrupted={turnInterrupted(row().userMessageID)}
                toolOpen={toolOpen[member.part.id] ?? false}
                onToolOpenChange={(open) => setToolOpen(member.part.id, open)}
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
          .map((ref) => getMsgPart(ref.messageID, ref.partID))
          .filter((part): part is ToolPart => part?.type === "tool")
      })
      return <SubagentChipRow parts={members()} />
    }

    if (row().group.type === "work") {
      const members = createMemo(() => {
        const group = row().group
        if (group.type !== "work") return []
        return group.refs
          .map((ref) => {
            const message = messageByID().get(ref.messageID)
            const part = getMsgPart(ref.messageID, ref.partID)
            // The predicate below used to claim `AssistantMessage` for whatever
            // `messageByID` returned; the group's refs carry no such promise.
            // It asserts only what the renderer needs — a runtime-produced row.
            if (!message || !isRuntimeMessage(message)) return undefined
            if (!part || part.type !== "tool") return undefined
            return { message, part }
          })
          .filter((member): member is { message: MessageType; part: ToolPart } => !!member)
      })

      const memberDefaultOpen = (part: ToolPart) =>
        partDefaultOpen(part, host.settings.shellToolPartsExpanded(), host.settings.editToolPartsExpanded())
      const memberOpen = createMemo(() =>
        members().some(
          (member) => (toolOpen[member.part.id] ?? memberDefaultOpen(member.part)) || toolRevealed[member.part.id] === true,
        ),
      )

      return (
        <WorkGroup
          parts={members().map((member) => member.part)}
          open={groupOpen[row().group.key] ?? false}
          onOpenChange={(open) => setGroupOpen(row().group.key, open)}
          busy={
            !props.progressBlocked?.() && workingTurn(row().userMessageID) && lastAssistantGroupKey().get(row().userMessageID) === row().group.key
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
                  turnDurationMs={turnDurationMs(row().userMessageID)}
                  turnInterrupted={turnInterrupted(row().userMessageID)}
                  defaultOpen={defaultOpen()}
                  toolOpen={toolOpen[member.part.id] ?? defaultOpen()}
                  onToolOpenChange={(open) => setToolOpen(member.part.id, open)}
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
      if (group.type !== "part") return undefined
      const value = messageByID().get(group.ref.messageID)
      return value && isRuntimeMessage(value) ? value : undefined
    })
    const part = createMemo(() => {
      const group = row().group
      if (group.type !== "part") return undefined
      return getMsgPart(group.ref.messageID, group.ref.partID)
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
                showAssistantCopyPartID={assistantCopyPartID(row().userMessageID)}
                turnDurationMs={turnDurationMs(row().userMessageID)}
                turnInterrupted={turnInterrupted(row().userMessageID)}
                defaultOpen={defaultOpen()}
                toolOpen={toolOpen[part().id] ?? defaultOpen()}
                onToolOpenChange={(open) => setToolOpen(part().id, open)}
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
        id={anchor() ? props.anchor(input.row().userMessageID) : undefined}
        data-message-id={input.row().userMessageID}
        data-content-message-id={TimelineRow.contentMessageID(input.row())}
        data-content-part-id={TimelineRow.contentPartID(input.row())}
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
          getMsgParts(commentStripRow().userMessageID).flatMap((part) => MessageComment.fromPart(part) ?? []),
        )
        return (
          <TimelineRowFrame row={commentStripRow}>
            <div class="w-full px-4 md:px-5 pb-2">
              <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
                <div class="flex w-max min-w-full justify-end gap-2">
                  <Index each={comments()}>
                    {(comment) => (
                      <div class="shrink-0 max-w-[260px] rounded-md border border-border-weak-base bg-background-stronger px-2.5 py-2">
                        <Switch>
                          <Match when={MessageComment.asImageMark(comment())}>
                            {(mark) => (
                              <div class="flex items-start gap-1.5 min-w-0" data-slot="image-mark-comment">
                                <ImageMarkBadge number={mark().number} />
                                <span class="text-12-regular text-text-strong whitespace-pre-wrap break-words">
                                  {mark().comment}
                                </span>
                              </div>
                            )}
                          </Match>
                          <Match when={MessageComment.asFile(comment())}>
                            {(file) => (
                              <>
                                <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
                                  <FileIcon node={{ path: file().path, type: "file" }} class="size-3.5 shrink-0" />
                                  <span class="truncate">{getFilename(file().path)}</span>
                                  <Show when={file().selection}>
                                    {(selection) => (
                                      <span class="shrink-0 text-text-weak">
                                        {selection().startLine === selection().endLine
                                          ? `:${selection().startLine}`
                                          : `:${selection().startLine}-${selection().endLine}`}
                                      </span>
                                    )}
                                  </Show>
                                </div>
                                <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words">
                                  {file().comment}
                                </div>
                              </>
                            )}
                          </Match>
                        </Switch>
                      </div>
                    )}
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
          const m = messageByID().get(userMessageRow().userMessageID)
          if (m && isRuntimeMessage(m) && m.role === "user") return m
          return undefined
        })
        return (
          <TimelineRowFrame row={userMessageRow}>
            <Show when={message()}>
              {(message) => (
                <TimelineUserMessage
                  message={message()}
                  parts={getMsgParts(userMessageRow().userMessageID)}
                  actions={props.actions}
                />
              )}
            </Show>
          </TimelineRowFrame>
        )
      }
      case "TurnDivider": {
        const turnDividerRow = rowOfTag(row, "TurnDivider", current)
        // D§3.6 / C4: terminal states are a centred hairline divider, a peer of the
        // "Worked for" fold row — never a card. "interrupted" durationMs (when derivable,
        // T8) reuses the same formatDuration voice as "Worked for {duration}".
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
                aria-hidden={workingTurn(assistantPartRow().userMessageID)}
              >
                {renderAssistantPartGroup(assistantPartRow, onSizeChange)}
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
      case "TurnLoading": {
        const loadingRow = rowOfTag(row, "TurnLoading", current)
        return (
          <TimelineRowFrame row={loadingRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineLoadingRow />
            </div>
          </TimelineRowFrame>
        )
      }
      case "Retry": {
        const retryRow = rowOfTag(row, "Retry", current)
        return (
          <TimelineRowFrame row={retryRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <ClaxedoSessionRetry status={sessionStatus()} show={activeMessageID() === retryRow().userMessageID} />
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
                  turnFold.setFolded(turnFoldRow().userMessageID, !turnFoldRow().folded)
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
          const id = sessionID()
          if (!revert || !id) return undefined
          return Promise.resolve(revert({ sessionID: id, messageID: diffSummaryRow().userMessageID }))
            .then(() => showToast({ title: host.t("ui.message.revertMessage") }))
            .catch(() => showToast({ title: host.t("common.requestFailed"), variant: "error" }))
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
                providerID={errorRow().providerID}
                modelID={errorRow().modelID}
                onAction={(value) => props.onFirstTurnRecovery?.(value, errorRow().userMessageID)}
              />
            </div>
          </TimelineRowFrame>
        )
      }
    }
    return undefined
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
    // Latch the last defined entry: the virtualizer can publish an item list that momentarily omits this key while
    // the row is still mounted (<For> disposes it a tick later); a non-keyed <Show> accessor read in that window
    // throws Solid's stale-value error and takes down the pane boundary. The latch renders the closing frame.
    const entry = createMemo<ReturnType<typeof liveEntry>>((previous) => liveEntry() ?? previous)
    const asyncFile = (value: TimelineRow.TimelineRow) => {
      if (value._tag !== "AssistantPart" || value.group.type !== "part") return false
      const part = getMsgPart(value.group.ref.messageID, value.group.ref.partID)
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
                // JSX applies `data-index` after refs and measureElement drops (warns on) unindexed elements — stamp it first; this is also the mount measurement.
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
      data-session-timeline-session-id={sessionID() ?? ""}
      data-session-timeline-user-count={String(props.userMessages.length)}
      data-session-timeline-row-count={String(timelineRows().length)}
      data-session-timeline-key-count={String(virtualRowKeys().length)}
      data-session-timeline-reveal-ready={initialRevealReady() ? "true" : "false"}
      data-session-timeline-progressive-ready={progressiveReady() ? "true" : "false"}
      data-session-timeline-nav-gutter={messageNavGutterVisible() ? "" : undefined}
      style={{ visibility: timelineInitialRevealVisibility({ ready: initialRevealReady() }) }}
      onClick={handleTimelinePathClick}
      onContextMenu={handleTimelineContextMenu}
    >
      <Show when={contextMenu()}>
        {(menu) => (
          <TimelineFileContextMenu
            menu={menu()}
            onOpenFile={openFileInPanel}
            onDismiss={() => setContextMenu(undefined)}
            resolvePath={(path) => resolveTimelineFilePath(path, host.placementPath)}
            showItemInFolder={host.platform.showItemInFolder}
          />
        )}
      </Show>
      <Show when={messageNavMountReady() && messageNavGutterVisible()}>
        <div data-slot="message-nav-gutter" class="pointer-events-none absolute inset-0 z-[45]">
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
      <div
        data-session-timeline-jump
        class="pointer-events-none absolute inset-x-0 bottom-6 z-[60] flex justify-center"
      >
        <div
          class="transition-all duration-200 ease-out"
          classList={{
            "opacity-100 translate-y-0 scale-100 pointer-events-auto": props.scroll.overflow && props.scroll.jump,
            "opacity-0 translate-y-2 scale-95 pointer-events-none": !props.scroll.overflow || !props.scroll.jump,
          }}
        >
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full border border-border-weaker-base bg-surface-raised-stronger-non-alpha text-text-base cursor-pointer p-0 transition-colors hover:border-border-weak-base"
            aria-label={host.t("session.timeline.scrollToBottom")}
            onClick={props.onResumeScroll}
          >
            <Show when={sessionStatus().kind === "working"} fallback={<Icon name="scroll-to-latest" size="large" />}>
              <span class="tl-dot-wave" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </Show>
          </button>
        </div>
      </div>
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
        <Show when={parentID()}>
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
        {/* The content ref wraps the queued bubbles too: the auto-scroll and
            scroll-state observers watch this element, and a bubble mounting
            below the virtual rows must count as the content growing. */}
        <div data-timeline-content ref={props.setContentRef} class="w-full">
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
          <Show when={props.queued}>
            {(queued) => (
              <div class="relative" classList={{ "-mt-10": timelineRows().length > 0 }}>
                <TimelineQueuedMessages queued={queued()} items={queuedNotYetInTranscript} centered={props.centered} t={host.t} />
              </div>
            )}
          </Show>
        </div>
      </ScrollView>
    </div>
  )
}
