import { sameArrayItems, samePartsRecord, sameTurnOutcome } from "./timeline-row-equality"
import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  For,
  mapArray,
  onCleanup,
  onSettled,
  Show,
  storePath,
  type Accessor,
} from "solid-js"
import type { JSX } from "@solidjs/web"
import { createKeySelector } from "@opencode-ai/ui/hooks"
import { useNavigate } from "@solidjs/router"
import { useMutation } from "@tanstack/solid-query"
import { createVirtualizer, defaultRangeExtractor, elementScroll, type VirtualItem } from "@/lib/solid-virtual"
import { observeElementOffsetReconnectAware, observeElementRectDeduped } from "./message-timeline-observe-offset"
import { markRendererPhase } from "@/platform/performance/renderer-trace"
import { Button } from "@opencode-ai/ui/button"
import { Card } from "@opencode-ai/ui/card"
import {
  ContextToolGroup,
  Message,
  MessageNav,
  MessageDivider,
  Part as MessagePart,
  partDefaultOpen,
  SubagentChipRow,
  WorkGroup,
} from "@/ui/session-kit"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ClaxedoSessionRetry } from "@/features/session/ui/components/claxedo-session-retry"
import { FirstTurnRecoveryCard } from "@/features/session/onboarding/first-turn-recovery-card"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type {
  AssistantMessage,
  Message as MessageType,
  Part as PartType,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import { showToast } from "@opencode-ai/ui/toast"
import { Binary } from "@opencode-ai/core/util/binary"
import { getFilename } from "@opencode-ai/core/util/path"
import { shouldMarkBoundaryGesture, normalizeWheelDelta } from "./message-gesture"
import { openTitleEditorPatch, resolveTitleSave } from "./session-title-editor"
import { nextSiblingAfterRemoval, sessionRemovalNavigation } from "./session-archive"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useData } from "@/ui/session-kit"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLanguage } from "@/platform/i18n/provider"
import { useSessionKey } from "@/features/session/session-layout"
import { useClaxedoState, usePaneId } from "@/features/session/app-ports"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useSettings } from "@/platform/settings/provider"
import { useSDK } from "@/features/session/app-ports"
import { messageAgentColor } from "@/features/session/ui/agent-color"
import { sessionTitle } from "@/features/session/data/session-title"
import type { SessionTurnOutcome } from "@/features/session/data/session-types"
import { createActivePaneProjection } from "../store/active-pane-projection"
import { createTimelineWorkingStatus } from "./timeline-working-status"
import { assistantMessageSettled, MessageComment, Timeline } from "./message-timeline.data"
import { TimelineRow, type TimelineRowMap } from "./timeline-row-model"
import { TimelineDiffSummaryRow, TimelineThinkingRow, TurnFoldRow } from "./message-timeline-turn-rows"
import { TimelineFileContextMenu } from "./timeline-file-context-menu"
import { createActiveConversationSnapshot } from "../conversation/conversation-registry"
import { sessionRoute, workspaceSessionRoute } from "@/platform/identity/route"
import { isSessionTurnActive } from "../store/session-store"
import { useSessionSyncOptional } from "@/features/session/providers/session-sync"
import { removeDirectorySessionTree, updateDirectorySession } from "../data/sync/directory-session-cache"
import { mergeCanonicalSessionUpdate } from "../data/sync/session-list-events"
import {
  timelineInitialRevealShouldScroll,
  timelineFirstFoldRevealShouldSchedule,
  timelineInitialRevealVisibility,
  timelineInteractionPlan,
} from "./view-state"
import {
  applyTimelinePrependAnchor,
  captureTimelinePrependAnchor,
  type TimelinePrependAnchor,
} from "./timeline-prepend-anchor"
import { createDisplayedFrameLoop } from "./timeline-displayed-frames"
import {
  createTimelineResizeAnchor,
  estimateLongMarkdownHeight,
  filterVirtualIndexes,
  scheduleConnectedMeasure,
  timelineRowFrameStyle,
} from "./timeline-virtualization"
import { createTurnFoldStore } from "./turn-fold-store"
import { formatDuration } from "@/ui/session-kit"
import { installTimelineMermaid } from "./mermaid-timeline"
import { installTimelineTables } from "./table-timeline"
import { sessionMessageScrollInset } from "./session-message-scroll-position"
import {
  timelineAnchorClickTarget,
  timelineExternalSourceClickTarget,
  timelineFileCandidateIsOpenable,
  timelineFileFocus,
  timelineFileTarget,
  resolveTimelinePath as resolveTimelineFilePath,
} from "./timeline-file-paths"
import { createMessageNavRoom } from "./message-nav-layout"
import { messageNavCurrentID, messageNavPreview, messageNavVisible } from "./message-nav-preview"
import { createMessageNavDeferredMount } from "./message-nav-deferred-mount"
import { scheduleTimelineFirstFoldReveal } from "./timeline-first-fold-reveal"
import { scheduleTimelineProgressiveRelease } from "./timeline-progressive-release"
import { BP_MD } from "@/ui/controls/breakpoints"
import { retargetSessionRef } from "@/platform/identity/session-ref"
import type { MessageTimelineProps } from "./message-timeline-props"
import "./message-nav-gutter.css"
import "./markdown-surfaces.css"

// Keep parity with the upstream session row model.
const emptyMessages: MessageType[] = []
const emptyParts: PartType[] = []
const emptyPartsRecord: Record<string, PartType[]> = {}
const emptyTools: ToolPart[] = []
const emptyAssistantMessages: AssistantMessage[] = []
const idle = { type: "idle" as const }

type FramedTimelineRow = Exclude<TimelineRow.TimelineRow, { _tag: "TurnGap" }>
type TimelineRowByTag<T extends TimelineRow.TimelineRow["_tag"]> = Extract<TimelineRow.TimelineRow, { _tag: T }>

const timelineFallbackItemSize = 60
const timelineInitialEstimatedItemSize = 180
const timelineColdFirstFoldOverscanLimit = 2
const timelineCache = new Map<string, { measurements: VirtualItem[]; toolOpen: Record<string, boolean | undefined> }>()

const taskDescription = (part: PartType, sessionID: string) => {
  if (part.type !== "tool" || part.tool !== "task") return
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  if (metadata?.sessionId !== sessionID) return
  const value = part.state.input?.description
  if (typeof value === "string" && value) return value
}

const pace = (width: number) => Math.round(Math.max(1200, Math.min(3200, (Math.max(width, 360) * 2000) / 900)))

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

const markBoundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) => {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) {
    input.onMarkScrollGesture(input.root)
    return
  }
  if (
    shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    })
  ) {
    input.onMarkScrollGesture(input.root)
  }
}

export function MessageTimeline(props: MessageTimelineProps) {
  let touchGesture: number | undefined

  const navigate = useNavigate()
  const sdk = useSDK()
  const data = useData()
  const sessionSync = useSessionSyncOptional()
  const settings = useSettings()
  const dialog = useDialog()
  const language = useLanguage()
  const { params, sessionKey } = useSessionKey()
  const ownerSessionKey = sessionKey()
  const cached = timelineCache.get(ownerSessionKey)
  const initialMeasurements = cached?.measurements
  const warmMeasurements = !!initialMeasurements?.length
  const boundColdFinalTurn = !warmMeasurements && props.status().type === "idle"
  const [initialTurnExpanded, setInitialTurnExpanded] = createSignal(!boundColdFinalTurn)
  const turnFold = createTurnFoldStore(ownerSessionKey)
  const platform = usePlatform()
  installTimelineMermaid(platform.renderMermaid)
  installTimelineTables()
  const claxedoState = useClaxedoState()
  const paneId = usePaneId()

  const openSubagent = (childSessionId: string, origin?: HTMLElement, subagentKey?: string) => {
    const contentId = claxedoState.layout.openSession(sdk.directory, childSessionId, "Subagent", {
      focus: false,
      sessionRef: retargetSessionRef({ sessionId: childSessionId, source: props.sessionRef }),
    })
    const childPane = claxedoState.wb.selectors.contentPane(contentId)
    const parentSessionId = sessionID() ?? ""
    const dedicatedPane = claxedoState.meta
      .findAll((item) => item.id !== contentId && item.returnFocus?.parentSessionId === parentSessionId)
      .map((item) => claxedoState.wb.selectors.contentPane(item.id))
      .find((id): id is string => !!id && id !== paneId)
    if (window.matchMedia(`(min-width: ${BP_MD}px)`).matches && paneId && !childPane && !dedicatedPane) {
      claxedoState.layout.splitContent(paneId, "right", contentId)
    } else if (dedicatedPane && !childPane) {
      claxedoState.wb.panes.assign(dedicatedPane, contentId)
      claxedoState.layout.showContent(contentId)
    } else {
      claxedoState.layout.showContent(contentId)
    }
    if (origin) {
      document
        .querySelectorAll<HTMLElement>(`[data-subagent-origin-id="${CSS.escape(contentId)}"]`)
        .forEach((item) => delete item.dataset.subagentOriginId)
      origin.dataset.subagentOriginId = contentId
      claxedoState.meta.patch(contentId, {
        returnFocus: {
          parentSessionId,
          subagentKey: subagentKey ?? origin.closest<HTMLElement>("[data-subagent-key]")?.dataset.subagentKey,
          originId: contentId,
        },
      })
    }
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          `[data-session-timeline-session-id="${CSS.escape(childSessionId)}"] [data-subagent-child-heading]`,
        )
        ?.focus()
    })
  }

  // Shared with the terminal's file links (timeline-file-paths.ts):
  // normalizes/relativizes, parses `:line[:col]`, refuses `~`/traversal/
  // out-of-workspace paths (which used to open blank tabs).
  const fileFocus = (raw: string) => timelineFileFocus(raw, sdk.directory)

  // Open a file in the workspace side panel (same path terminal file links take
  // via terminal-content.tsx `onFileLinkOpen`), NOT `platform.openPath` (which
  // is desktop-only and hands the file to the OS). No `navigator: "files"` — it
  // would slide the tree drawer over the file tab this click just opened.
  const openFileInPanel = (raw: string) => {
    const target = fileFocus(raw)
    if (!target) return
    claxedoState.workspacePanel.open({
      workspaceDir: sdk.directory.replace(/\/$/, ""),
      targetPaneId: paneId,
      focus: { kind: "file", path: target.path, intent: "tab", line: target.line, col: target.col },
    })
  }

  // Path-kind inline-code chips in assistant markdown (T16). Anchors are handled
  // in the capture phase below (not here) so preventDefault beats the native
  // target="_blank" new-window, which in Electron otherwise fired alongside this
  // bubble handler — opening the link in a browser AND in the panel.
  let candidateFileController: AbortController | undefined
  onCleanup(() => candidateFileController?.abort())
  createEffect(
    () => props.active(),
    (active) => {
      if (!active) candidateFileController?.abort()
    },
  )
  const handleTimelinePathClick = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    const target = event.target instanceof Element ? event.target : null
    const selection = typeof window !== "undefined" ? window.getSelection() : null
    if (selection && !selection.isCollapsed) return // don't hijack a text-selection click
    if (target?.closest("a[href]")) return // anchors → capture handler below
    const chip = target?.closest<HTMLElement>(
      '[data-inline-code-kind="path"], [data-inline-code-kind="path-candidate"]',
    )
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
    void timelineFileCandidateIsOpenable(raw, sdk.directory, (query) =>
      sdk.client.find.files({ query, dirs: "false" }, { signal: controller.signal }).then(
        (response) => response.data ?? [],
        () => [],
      ),
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
  const messageNavGutterVisible = createMemo(
    () =>
      messageNavVisible((props.navMessages ?? props.userMessages).length) &&
      messageNavHasRoom() &&
      !!props.onMessageSelect,
  )

  let disposeTimelineRoot: (() => void) | undefined
  onCleanup(() => disposeTimelineRoot?.())
  const registerTimelineRoot = (el: HTMLDivElement) => {
    disposeTimelineRoot?.()
    setTimelineRoot(el)
    const onOpenSubagent = (raw: Event) => {
      const event = raw as CustomEvent<{ childSessionId?: string; subagentKey?: string }>
      const childSessionId = event.detail?.childSessionId
      if (!childSessionId) return
      event.preventDefault()
      const origin =
        event.target instanceof Element
          ? (event.target.closest<HTMLElement>("button, a, [tabindex]") ?? undefined)
          : undefined
      openSubagent(childSessionId, origin, event.detail.subagentKey)
    }
    el.addEventListener("claxedo:open-subagent", onOpenSubagent)
    const onCapture = (event: MouseEvent) => {
      const externalSourceUrl = timelineExternalSourceClickTarget(event)
      if (externalSourceUrl) {
        event.preventDefault()
        event.stopImmediatePropagation()
        claxedoState.workspacePanel.open({
          workspaceDir: sdk.directory.replace(/\/$/, ""),
          targetPaneId: paneId,
          navigator: null,
          focus: { kind: "browser", url: externalSourceUrl },
        })
        return
      }
      const raw = timelineAnchorClickTarget(event)
      if (!raw || !fileFocus(raw)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      openFileInPanel(raw)
    }
    el.addEventListener("click", onCapture, { capture: true })
    // A ref callback runs without a reactive owner in Solid 2, so the teardown is
    // handed to the component-scoped `disposeTimelineRoot` instead of `onCleanup`.
    // Candidate paths are probed lazily on click (`timelineFileCandidateIsOpenable`),
    // so there is no promotion observer to stop here.
    disposeTimelineRoot = () => {
      el.removeEventListener("claxedo:open-subagent", onOpenSubagent)
      el.removeEventListener("click", onCapture, { capture: true })
    }
  }

  // File context menu (T11): right-click a file link/path → Open / Copy path / Reveal.
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; path: string } | undefined>()
  const handleTimelineContextMenu = (event: MouseEvent) => {
    const raw = timelineFileTarget(event.target)
    if (!raw) return
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY, path: raw })
  }

  const [listRoot, setListRoot] = createSignal<HTMLDivElement>()
  const sessionID = createMemo(() => params.id)
  const sessionConversation = createActiveConversationSnapshot({
    directory: () => sdk.directory,
    sessionID,
    active: props.active,
  })
  const sessionMessages = createMemo(() => sessionConversation()?.messages ?? emptyMessages)
  const messageByID = createMemo(() => new Map(sessionMessages().map((message) => [message.id, message] as const)))
  const assistantMessagesByParent = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    for (const message of sessionMessages()) {
      if (message.role !== "assistant") continue
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
      (item): item is AssistantMessage => item.role === "assistant" && typeof item.time.completed !== "number",
    ),
  )
  const sessionStatus = createActivePaneProjection({
    active: props.active,
    read: () => props.status() ?? idle,
    initial: idle,
  })
  const working = createMemo(() => isSessionTurnActive({ status: sessionStatus() }))
  const directorySessionRows = createActivePaneProjection({
    active: props.active,
    read: props.directorySessions,
    initial: [] as ReturnType<MessageTimelineProps["directorySessions"]>,
  })
  const directorySession = (sessionID: string | undefined) =>
    sessionID ? directorySessionRows().find((session) => session.id === sessionID) : undefined
  const directoryAgents = createActivePaneProjection({
    active: props.active,
    read: () => data.store.agent ?? [],
    initial: [] as NonNullable<typeof data.store.agent>,
  })
  const tint = createMemo(() => messageAgentColor(sessionMessages(), directoryAgents()))
  const resolveAmbientSubagents = () => {
    const id = sessionID()
    if (!id) return []
    return (data.resolveSubagents?.(id) ?? []).filter((subagent) => subagent.ambient)
  }
  const ambientSubagents = createActivePaneProjection({
    active: props.active,
    read: resolveAmbientSubagents,
    initial: [] as ReturnType<typeof resolveAmbientSubagents>,
  })

  const workingStatus = createTimelineWorkingStatus({ active: props.active, working })

  const activeMessageID = createMemo(() => {
    const parentID = pending()?.parentID
    if (parentID) {
      const messages = sessionMessages()
      const result = Binary.search(messages, parentID, (message) => message.id)
      const message = result.found ? messages[result.index] : messages.find((item) => item.id === parentID)
      if (message && message.role === "user") return message.id
    }

    const status = sessionStatus()
    if (status.type !== "idle") {
      const messages = sessionMessages()
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") return messages[i].id
      }
    }

    return undefined
  })
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return directorySession(id)
  })
  const titleValue = createActivePaneProjection<string | undefined>({
    active: props.active,
    read: props.title,
    initial: undefined,
  })
  const titleLabel = createMemo(() => sessionTitle(titleValue()))
  const parentID = createMemo(() => props.parentID)
  const parent = createMemo(() => {
    const id = parentID()
    if (!id) return
    return directorySession(id)
  })
  const parentConversation = createActiveConversationSnapshot({
    directory: () => sdk.directory,
    sessionID: parentID,
    active: props.active,
  })
  const parentMessages = createMemo(() => parentConversation()?.messages ?? emptyMessages)
  const parentTitle = createMemo(() => sessionTitle(parent()?.title) ?? language.t("command.session.new"))
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
    if (!id) return
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
    return language.t("command.session.new")
  })
  const showHeader = createMemo(() => !!(titleValue() || parentID()))

  // Per-message inputs are equality-gated so a streaming part event (which
  // produces a new conversation snapshot + a new assistantMessagesByParent Map
  // every tick) only re-runs constructMessageRows for the message whose parts
  // actually changed. Message and Part[] identities are stable for unchanged
  // messages (see opencodeConversationProjection's WeakMap cache), so the cheap
  // identity comparisons below turn wholesale per-tick recomputation into
  // O(changed turn) work.
  const statusType = createMemo(() => sessionStatus().type)
  const lastTurnOutcome = createMemo(() => info()?.lastTurn, { equals: sameTurnOutcome, loadingValue: undefined })
  // O(1) keyed selection for the active message: flips two per-key signals per
  // change instead of re-running every row's comparison (or worse, rc.1's
  // createProjection store-commit walk — measured in
  // contract-bench/framework-micro.ts). Transcripts can hold thousands of turns.
  const activeMessageAt = createKeySelector(activeMessageID)
  const messageRowMemos = createMemo(
    mapArray(
      () => props.userMessages,
      (userMessage, indexAccessor) => {
        const turnAssistants = createMemo(
          () => assistantMessagesByParent().get(userMessage.id) ?? emptyAssistantMessages,
          { equals: sameArrayItems, loadingValue: emptyAssistantMessages },
        )
        const visibleAssistantMessageIDs = createMemo(() => {
          if (initialTurnExpanded() || indexAccessor() !== props.userMessages.length - 1) return
          const finalAssistant = turnAssistants().at(-1)
          return finalAssistant ? new Set([finalAssistant.id]) : undefined
        })
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
          { equals: samePartsRecord, loadingValue: emptyPartsRecord },
        )
        const isActive = () => activeMessageAt(userMessage.id)
        return createMemo((previous: TimelineRow.TimelineRow[] | undefined) => {
          const parts = turnParts()
          const rows = Timeline.constructMessageRows(
            userMessage,
            (messageID) => parts[messageID] ?? emptyParts,
            turnAssistants(),
            indexAccessor(),
            settings.general.showReasoningSummaries(),
            statusType(),
            isActive(),
            props.firstTurnRecovery !== false && indexAccessor() === 0,
            (userMessageID) => turnFold.isFolded(userMessageID),
            settings.general.timelineFoldWhileRunning(),
            lastTurnOutcome(),
            visibleAssistantMessageIDs(),
          )

          return TimelineRow.reuse(previous, rows)
        })
      },
    ),
  )

  const timelineRows = createMemo((previous: TimelineRow.TimelineRow[] | undefined) => {
    const rows = messageRowMemos().flatMap((memo) => memo())
    return TimelineRow.reuse(previous, rows)
  })

  let prependAnchor: TimelinePrependAnchor | undefined
  // Display-gated, not a bare requestAnimationFrame: a stashed surface keeps
  // this timeline mounted with no layout for the anchor to settle against.
  const prependAnchorFrames = createDisplayedFrameLoop({ displayed: props.active })
  let prependLoading = false
  const clearPrependAnchor = () => {
    prependLoading = false
    prependAnchor = undefined
    prependAnchorFrames.stop()
  }
  const capturePrependAnchor = () => {
    prependLoading = true
    updatePrependAnchor()
  }
  const updatePrependAnchor = () => {
    const root = listRoot()
    if (!root) return
    prependAnchor = captureTimelinePrependAnchor(root) ?? prependAnchor
  }
  const restorePrependAnchor = () => {
    prependLoading = false
    applyPrependAnchor()
  }
  const applyPrependAnchor = () => {
    const anchor = prependAnchor
    const root = listRoot()
    if (!root || !anchor) return
    let frames = 0
    let stable = 0
    const resolveRowStart = (key: string) => {
      const index = timelineRows().findIndex((row) => TimelineRow.key(row) === key)
      return index < 0 ? undefined : virtualizer.getOffsetForIndex(index, "start")?.[0]
    }
    prependAnchorFrames.start(() => {
      if (applyTimelinePrependAnchor(root, anchor, resolveRowStart) === "adjusted") {
        stable = 0
      } else {
        stable += 1
      }
      frames += 1
      if (stable >= 30 || frames >= 180) {
        prependAnchor = undefined
        return false
      }
      return true
    })
  }
  onCleanup(() => prependAnchorFrames.stop())
  const [toolOpen, setToolOpen] = createStore<Record<string, boolean | undefined>>(cached?.toolOpen ?? {})
  const initialRowCount = timelineRows().length
  const [renderOverscan, setRenderOverscan] = createSignal(initialMeasurements?.length ? 6 : 1)
  const [renderRangeLimit, setRenderRangeLimit] = createSignal(
    warmMeasurements
      ? Number.MAX_SAFE_INTEGER
      : initialRowCount > 0
        ? Math.min(timelineColdFirstFoldOverscanLimit, initialRowCount)
        : 1,
  )
  const [initialRevealReady, setInitialRevealReady] = createSignal(warmMeasurements || initialRowCount === 0)
  const [progressiveReady, setProgressiveReady] = createSignal(warmMeasurements || initialRowCount === 0)
  const messageNavMountReady = createMessageNavDeferredMount(initialRevealReady, messageNavGutterVisible)
  let initialRowsScheduled = initialRowCount > 0
  let cancelFirstFoldReveal: (() => void) | undefined
  let cancelProgressiveRelease: (() => void) | undefined
  const cancelBackgroundRangeRelease = () => {
    cancelProgressiveRelease?.()
    cancelProgressiveRelease = undefined
  }
  const prepareScrollOverscan = () => {
    cancelBackgroundRangeRelease()
    if (!initialTurnExpanded()) setInitialTurnExpanded(true)
    if (renderOverscan() < 6) setRenderOverscan(6)
    if (renderRangeLimit() !== Number.MAX_SAFE_INTEGER) setRenderRangeLimit(Number.MAX_SAFE_INTEGER)
  }
  const prepareInteractionScroll = () => {
    const plan = timelineInteractionPlan({
      prependLoading,
      hasScrollGesture: props.hasScrollGesture(),
    })
    if (plan.prepareOverscan) prepareScrollOverscan()
    if (plan.clearPrependAnchor) clearPrependAnchor()
    return plan
  }
  let virtualContent: HTMLDivElement | undefined
  const resizeAnchor = createTimelineResizeAnchor()
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
    initialOffset: () => (props.shouldAnchorBottom() ? Number.MAX_SAFE_INTEGER : 0),
    initialMeasurementsCache: initialMeasurements,
    estimateSize: (index) => {
      const rows = timelineRows()
      const row = rows[index]
      if (row?._tag !== "AssistantPart") return timelineInitialEstimatedItemSize
      // Initial bottom-anchored layout only needs precise estimates around the
      // first visible fold. Scanning every historical Markdown body blocks the
      // viewport callback even though those rows remain virtual and will be
      // measured when the user approaches them.
      if (index < rows.length - 50) return timelineInitialEstimatedItemSize
      const group = row.group
      if (group.type !== "part") return timelineInitialEstimatedItemSize
      const part = getMsgParts(group.ref.messageID).find((item) => item.id === group.ref.partID)
      if (part?.type !== "text") return timelineInitialEstimatedItemSize
      return estimateLongMarkdownHeight(part.text) ?? timelineInitialEstimatedItemSize
    },
    scrollToFn: (offset, options, instance) => {
      if (virtualContent) virtualContent.style.height = `${instance.getTotalSize()}px`
      elementScroll(offset, options, instance)
    },
    get getItemKey() {
      const rows = timelineRows()
      return (index: number) => {
        const row = rows[index]
        if (!row) return `removed:${index}`
        return TimelineRow.key(row)
      }
    },
    get anchorTo() {
      return props.shouldAnchorBottom() ? "end" : "start"
    },
    get followOnAppend() {
      return props.shouldAnchorBottom()
    },
    scrollEndThreshold: 80,
    overscan: 50,
    paddingEnd: 64,
    // A getter, not a stable closure: the virtualizer memoizes the extractor's
    // output keyed on the extractor's IDENTITY plus the computed range/count
    // (virtual-core getVirtualIndexes deps). Solid signals read while the
    // extractor RUNS are invisible to that memo, so a stable closure serves
    // stale indexes whenever only those signals change (the renderRangeLimit
    // ramp after a reload left the timeline mounting one row forever).
    // Reading them here — at option-read time inside the adapter's tracked
    // setOptions pass — subscribes the virtualizer and mints a new identity.
    get rangeExtractor() {
      const rows = timelineRows()
      const activeID = activeMessageID()
      const overscan = renderOverscan()
      const rangeLimit = renderRangeLimit()
      const pinned = resizeAnchor.pinnedIndexes()
      const anchorBottom = props.shouldAnchorBottom()
      return (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
        const active = activeID
          ? rows.findLastIndex((row) => "userMessageID" in row && row.userMessageID === activeID)
          : -1
        const indexes = defaultRangeExtractor({ ...range, overscan })
        // A cold cap may trim OVERSCAN, never viewport-visible rows. The old
        // `slice(-rangeLimit)` could keep four estimated rows even after their
        // canonical Markdown shrank and the virtualizer expanded the visible
        // range to six or eight, leaving a blank fold until background release.
        const visibleCount = Math.max(0, range.endIndex - range.startIndex + 1)
        const retainedCount = Math.max(rangeLimit, visibleCount)
        const visibleIndexes = anchorBottom && retainedCount < indexes.length ? indexes.slice(-retainedCount) : indexes
        return filterVirtualIndexes(
          [...new Set([...pinned, ...visibleIndexes, ...(active < 0 ? [] : [active])])].sort((a, b) => a - b),
          range.count,
        )
      }
    },
  })
  resizeAnchor.install({
    virtualizer,
    root: listRoot,
    displayed: props.active,
    shouldAnchorBottom: props.shouldAnchorBottom,
    hasScrollGesture: props.hasScrollGesture,
  })
  // The prepend-anchor loop parks itself while stashed (it reads
  // `props.active`). Returning needs the nudge: a parked loop has no frame on
  // which to notice that its surface came back.
  createEffect(() => {
    if (props.active()) prependAnchorFrames.resume()
  })
  const timelineRowByKey = createMemo(() => new Map(timelineRows().map((row) => [TimelineRow.key(row), row] as const)))
  const virtualItemByKey = createMemo(
    () => new Map(virtualizer.getVirtualItems().map((item) => [item.key, item] as const)),
  )
  const virtualRowKeys = createMemo(() => virtualizer.getVirtualItems().map((item) => item.key as string))
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
    // Scroll-frequency path: plain peeked items, one row-memo read per event.
    const rows = timelineRows()
    const id = messageNavCurrentID(
      virtualizer.peekVirtualItems().flatMap((item) => {
        const row = rows[item.index]
        return row && "userMessageID" in row ? [{ id: row.userMessageID, start: item.start }] : []
      }),
      root.scrollTop + 100,
    )
    if (id !== viewportMessageID()) setViewportMessageID(id)
  }

  // Fresh tuple: re-register on every invalidation, exactly as the tracked body did.
  createEffect(
    () => [props.setScrollToEnd, props.setScrollToMessage, props.setHistoryAnchor] as const,
    () => {
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
        const sticky = root.querySelector("[data-session-title]")
        const stickyBottom = sticky instanceof HTMLElement ? sticky.getBoundingClientRect().bottom : box.top
        const inset = sessionMessageScrollInset({ rootTop: box.top, stickyBottom })
        virtualizer.scrollToOffset(Math.max(0, offset[0] - inset), { behavior })
        return true
      })
      props.setHistoryAnchor?.({ capture: capturePrependAnchor, restore: restorePrependAnchor })
    },
  )

  let firstFoldRevealKey: string | undefined
  const scheduleBackgroundRangeRelease = () => {
    cancelBackgroundRangeRelease()
    if (!props.active()) return
    const activationKey = sessionKey()
    cancelProgressiveRelease = scheduleTimelineProgressiveRelease({
      sessionID: sessionID(),
      activationKey,
      // A retained SessionPage keeps the same session key while hidden. Pane
      // ownership is therefore part of activation identity: otherwise every
      // cold surface releases its full virtual range after the quiet timer and
      // parses Markdown in the background while the user is in another task.
      currentActivationKey: () => (props.active() ? sessionKey() : ""),
      release: () => {
        cancelProgressiveRelease = undefined
        setInitialTurnExpanded(true)
        setRenderRangeLimit(Number.MAX_SAFE_INTEGER)
      },
    })
  }

  // `revealed` is a parameter, not a latch read -- see timelineFirstFoldRevealShouldSchedule.
  const scheduleFirstFoldReveal = (revealed = initialRevealReady()) => {
    if (!timelineFirstFoldRevealShouldSchedule({ warmMeasurements, revealed, rowCount: timelineRows().length })) return
    const activationKey = sessionKey()
    if (firstFoldRevealKey === activationKey && cancelFirstFoldReveal) return
    cancelFirstFoldReveal?.()
    firstFoldRevealKey = activationKey
    cancelFirstFoldReveal = scheduleTimelineFirstFoldReveal({
      activationKey,
      currentActivationKey: sessionKey,
      prepare: () => {
        // Force the capped fold's virtual measurements while the surface is
        // still hidden, then perform the bottom-anchor write before paint.
        virtualizer.getTotalSize()
        const root = listRoot()
        const nativeAtEnd = root ? root.scrollHeight - root.clientHeight - root.scrollTop <= 1 : false
        if (
          timelineInitialRevealShouldScroll({
            hasScrollGesture: props.hasScrollGesture(),
            shouldAnchorBottom: props.shouldAnchorBottom(),
          }) &&
          !nativeAtEnd
        )
          virtualizer.scrollToEnd()
      },
      reveal: () => {
        cancelFirstFoldReveal = undefined
        firstFoldRevealKey = undefined
        setProgressiveReady(true)
        setInitialRevealReady(true)
      },
    })
  }

  // Full-history rendering belongs to the visible surface. If the user leaves
  // during the quiet window, cancel it; a later warm return starts a fresh
  // quiet window before expanding the range. The capped first fold and its
  // cached measurements remain mounted throughout.
  createEffect(
    () => ({
      active: props.active(),
      revealed: initialRevealReady(),
      capped: renderRangeLimit() !== Number.MAX_SAFE_INTEGER,
    }),
    ({ active, revealed, capped }) => {
      if (!active) {
        cancelBackgroundRangeRelease()
        return
      }
      if (revealed && capped && !cancelProgressiveRelease) scheduleBackgroundRangeRelease()
    },
  )

  // Self-feeding: this body writes the render-range and reveal latches its own
  // readers depend on, so only "how many rows are there" belongs in the tracked
  // phase. The once-ever latch stays, since rows can empty and refill on a
  // session swap.
  createEffect(
    () => timelineRows().length,
    (length) => {
      if (length === 0 || initialRowsScheduled) return
      initialRowsScheduled = true
      if (warmMeasurements) return
      setRenderRangeLimit(Math.min(timelineColdFirstFoldOverscanLimit, length))
      setInitialRevealReady(false)
      setProgressiveReady(false)
      scheduleFirstFoldReveal(false)
    },
  )

  onSettled(() => {
    markRendererPhase(`timeline.mount.${ownerSessionKey}`)
    scheduleFirstFoldReveal()
  })

  let bottomAnchorSessionKey = ""
  let bottomAnchorFrame: number | undefined

  const maybeAnchorBottom = () => {
    const key = sessionKey()
    if (bottomAnchorSessionKey === key) return
    if (timelineRows().length === 0) return
    bottomAnchorSessionKey = key
    if (!props.shouldAnchorBottom()) return
    if (!initialRevealReady()) {
      scheduleFirstFoldReveal()
      return
    }
    if (bottomAnchorFrame !== undefined) cancelAnimationFrame(bottomAnchorFrame)
    clearPrependAnchor()
    bottomAnchorFrame = requestAnimationFrame(() => {
      bottomAnchorFrame = undefined
      if (sessionKey() !== key) return
      const root = listRoot()
      if (!(root && root.scrollHeight - root.clientHeight - root.scrollTop <= 1)) virtualizer.scrollToEnd()
    })
  }

  let measuredSessionKey = sessionKey()
  // Fresh tuple: every row-count change re-checks, as before. props.shouldAnchorBottom()
  // stays out — maybeAnchorBottom reads it as current state, and its own key latch
  // already makes a re-run on that read a no-op.
  createEffect(
    () => [sessionKey(), timelineRows().length] as const,
    ([key]) => {
      if (measuredSessionKey !== key) ((measuredSessionKey = key), virtualizer.measure())
      maybeAnchorBottom()
    },
  )

  onCleanup(() => {
    timelineCache.delete(ownerSessionKey)
    timelineCache.set(ownerSessionKey, { measurements: virtualizer.takeSnapshot(), toolOpen: { ...toolOpen } })
    turnFold.persist()
    while (timelineCache.size > 64) timelineCache.delete(timelineCache.keys().next().value!) // remounting without a snapshot re-estimates heights and visibly shifts; 16 thrashed
    if (bottomAnchorFrame !== undefined) cancelAnimationFrame(bottomAnchorFrame)
    cancelFirstFoldReveal?.()
    cancelBackgroundRangeRelease()
    resizeAnchor.dispose()
    props.setScrollToEnd?.(() => {})
    props.setScrollToMessage?.(undefined)
    props.setHistoryAnchor?.({ capture: () => {}, restore: () => {} })
  })

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    menuOpen: false,
    pendingRename: false,
  })
  let titleRef: HTMLInputElement | undefined

  const [bar, setBar] = createStore({
    ms: pace(640),
  })

  let head: HTMLDivElement | undefined

  // Width comes from the observer's `contentRect`: re-reading `head.clientWidth`
  // forced a layout from inside the callback. Took this stack from 123 layout
  // invalidations to 0, but the flow's total held at ~522 -- insertion bound.
  const updateTitleMetrics = (width?: number) => {
    const measured = width ?? head?.clientWidth ?? 0
    if (measured <= 0) return
    const next = pace(measured)
    if (next === bar.ms) return
    setBar(storePath("ms", next))
  }

  createResizeObserver(
    () => head,
    ({ width }) => updateTitleMetrics(width),
  )

  const bindListRoot = (root: HTMLDivElement) => {
    if (root === listRoot()) return
    setListRoot(root)
    props.setScrollRef(root)
  }

  const boundaryGesture = (event: { currentTarget: HTMLDivElement; target: EventTarget | null }, delta: number) =>
    markBoundaryGesture({
      root: event.currentTarget,
      target: event.target,
      delta,
      onMarkScrollGesture: props.onMarkScrollGesture,
    })

  const handleListWheel = (event: WheelEvent & { currentTarget: HTMLDivElement }) => {
    prepareInteractionScroll()
    const delta = normalizeWheelDelta({
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      rootHeight: event.currentTarget.clientHeight,
    })
    if (!delta) return
    boundaryGesture(event, delta)
  }

  const handleListTouchStart = (event: TouchEvent) => {
    prepareInteractionScroll()
    touchGesture = event.touches[0]?.clientY
  }

  const handleListTouchMove = (event: TouchEvent & { currentTarget: HTMLDivElement }) => {
    const next = event.touches[0]?.clientY
    const prev = touchGesture
    touchGesture = next
    if (next === undefined || prev === undefined) return

    const delta = prev - next
    if (!delta) return

    boundaryGesture(event, delta)
  }

  const handleListTouchEnd = () => {
    touchGesture = undefined
  }

  const handleListPointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    prepareInteractionScroll()
    props.onMarkScrollGesture(event.target)
  }

  // Drag-to-select starts on a child node, not the list — mark it so autoscroll yields.
  const handleListPointerMove = (event: PointerEvent) => {
    if (event.buttons === 1) props.onMarkScrollGesture(event.target)
  }

  const handleListScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (prependLoading) updatePrependAnchor()
    updateViewportMessage(event.currentTarget)
    props.onScheduleScrollState(event.currentTarget)
    props.onHistoryScroll()
    // The virtualizer and resizeItem re-anchor own bottom-following.
    if (!props.hasScrollGesture()) return
    props.onUserScroll()
    props.onAutoScrollHandleScroll()
    props.onMarkScrollGesture(event.currentTarget)
  }

  onCleanup(() => {
    props.setScrollRef(undefined)
  })

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const titleMutation = useMutation(() => ({
    mutationFn: async (input: { id: string; title: string }) => {
      const baseline = directorySession(input.id)
      const result = await sdk.client.session.update({ sessionID: input.id, title: input.title })
      return { result, baseline }
    },
    onSuccess: ({ result, baseline }, input) => {
      if (result.data) {
        updateDirectorySession(sdk.directory, input.id, (session) =>
          mergeCanonicalSessionUpdate(session, result.data, baseline),
        )
      }
      setTitle(storePath("editing", false))
    },
    onError: (err) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(err),
      })
    },
  }))

  createEffect(
    sessionKey,
    () =>
      void setTitle((state) => {
        Object.assign(state, {
          draft: "",
          editing: false,
          menuOpen: false,
          pendingRename: false,
        })
      }),
    { defer: true },
  )

  createEffect(
    () => [parentID(), childTaskDescription()] as const,
    ([id, description]) => {
      if (!id || description) return
      if (parentMessages().length > 0) return
      void Promise.resolve(sessionSync?.syncSession?.(id)).catch(() => undefined)
    },
    { defer: true },
  )

  const openTitleEditor = () => {
    const patch = openTitleEditorPatch({
      hasSession: !!sessionID(),
      isChild: !!parentID(),
      currentTitle: titleLabel(),
    })
    if (!patch) return
    setTitle((state) => {
      Object.assign(state, patch)
    })
    requestAnimationFrame(() => {
      titleRef?.focus()
      titleRef?.select()
    })
  }

  const closeTitleEditor = () => {
    if (titleMutation.isPending) return
    setTitle(storePath("editing", false))
  }

  const saveTitleEditor = () => {
    const id = sessionID()
    if (!id) return
    if (titleMutation.isPending) return

    const decision = resolveTitleSave({ draft: title.draft, currentTitle: titleLabel() })
    if (!decision.commit) {
      setTitle(storePath("editing", false))
      return
    }

    titleMutation.mutate({ id, title: decision.title })
  }

  const navigateAfterSessionRemoval = (sessionID: string, parentID?: string, nextSessionID?: string) => {
    const nav = sessionRemovalNavigation({
      currentSessionID: params.id,
      targetSessionID: sessionID,
      parentID,
      nextSessionID,
    })
    if (nav.kind === "parent" || nav.kind === "next") {
      navigate(sessionRoute(nav.sessionID))
      return
    }
    if (nav.kind === "root") navigate(workspaceSessionRoute(sdk.directory))
  }

  const archiveSession = async (sessionID: string) => {
    const session = directorySession(sessionID)
    if (!session) return

    const nextSession = nextSiblingAfterRemoval(directorySessionRows(), sessionID)

    await sdk.client.session
      .update({ sessionID, time: { archived: Date.now() } })
      .then(() => {
        removeDirectorySessionTree(sdk.directory, sessionID)
        navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
      })
      .catch((err) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  const deleteSession = async (sessionID: string) => {
    const session = directorySession(sessionID)
    if (!session) return false

    const nextSession = nextSiblingAfterRemoval(
      directorySessionRows().filter((s) => !s.parentID && !s.time?.archived),
      sessionID,
    )

    const result = await sdk.client.session
      .delete({ sessionID })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!result) return false

    removeDirectorySessionTree(sdk.directory, sessionID)
    navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
    return true
  }

  const navigateParent = () => {
    if (!parentID()) return
    props.onNavigateParent()
  }

  function DialogDeleteSession(props: { sessionID: string; title?: string }) {
    const name = createMemo(
      () => sessionTitle(props.title) ?? language.t("command.session.new"),
    )
    const handleDelete = async () => {
      await deleteSession(props.sessionID)
      dialog.close()
    }

    return (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("session.delete.confirm", { name: name() })}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const turnAssistantMessages = (userMessageID: string) =>
    assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages
  const turnSettled = (userMessageID: string) => turnAssistantMessages(userMessageID).some(assistantMessageSettled)
  const workingTurn = (userMessageID: string) =>
    sessionStatus().type !== "idle" && activeMessageAt(userMessageID) && !turnSettled(userMessageID)

  const turnDurationMs = (userMessageID: string) => {
    const message = messageByID().get(userMessageID)
    if (!message || message.role !== "user") return
    return Timeline.turnDurationMs(message, turnAssistantMessages(userMessageID))
  }

  const turnInterrupted = (userMessageID: string) =>
    Timeline.turnInterrupted(turnAssistantMessages(userMessageID), info()?.lastTurn)

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
  }

  const getMsgPart = (messageID: string, partID: string) => getMsgParts(messageID).find((part) => part.id === partID)

  const renderAssistantPartGroup = (row: Accessor<TimelineRowMap["AssistantPart"]>, onSizeChange?: () => void) => {
    if (row().group.type === "context") {
      const parts = createMemo(() => {
        const group = row().group
        if (group.type !== "context") return emptyTools
        return group.refs
          .map((ref) => getMsgPart(ref.messageID, ref.partID))
          .filter((part): part is ToolPart => part?.type === "tool")
      })

      return (
        <ContextToolGroup
          parts={parts()}
          busy={
            workingTurn(row().userMessageID) && lastAssistantGroupKey().get(row().userMessageID) === row().group.key
          }
          onSizeChange={onSizeChange}
        />
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
      return <SubagentChipRow parts={members()} onOpen={openSubagent} />
    }

    if (row().group.type === "work") {
      const members = createMemo(() => {
        const group = row().group
        if (group.type !== "work") return []
        return group.refs
          .map((ref) => {
            const message = messageByID().get(ref.messageID)
            const part = getMsgPart(ref.messageID, ref.partID)
            if (!message || !part || part.type !== "tool") return undefined
            return { message, part }
          })
          .filter((member): member is { message: AssistantMessage; part: ToolPart } => !!member)
      })

      return (
        <WorkGroup
          parts={members().map((member) => member.part)}
          busy={
            workingTurn(row().userMessageID) && lastAssistantGroupKey().get(row().userMessageID) === row().group.key
          }
          onSizeChange={onSizeChange}
        >
          <For each={members()}>
            {(member) => {
              const defaultOpen = createMemo(() =>
                partDefaultOpen(
                  member.part,
                  settings.general.shellToolPartsExpanded(),
                  settings.general.editToolPartsExpanded(),
                ),
              )
              return (
                <MessagePart
                  part={member.part}
                  message={member.message}
                  turnDurationMs={turnDurationMs(row().userMessageID)}
                  turnInterrupted={turnInterrupted(row().userMessageID)}
                  defaultOpen={defaultOpen()}
                  toolOpen={toolOpen[member.part.id] ?? defaultOpen()}
                  onToolOpenChange={(open) => setToolOpen(storePath(member.part.id, open))}
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
      if (group.type !== "part") return
      return messageByID().get(group.ref.messageID)
    })
    const part = createMemo(() => {
      const group = row().group
      if (group.type !== "part") return
      return getMsgPart(group.ref.messageID, group.ref.partID)
    })
    const defaultOpen = createMemo(() => {
      const item = part()
      if (!item) return
      return partDefaultOpen(item, settings.general.shellToolPartsExpanded(), settings.general.editToolPartsExpanded())
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
                onToolOpenChange={(open) => setToolOpen(storePath(part().id, open))}
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
        class={{
          "min-w-0 w-full max-w-full": true,
          "md:max-w-192 2xl:max-w-[880px]": props.centered,
          "md:mx-auto": props.centered,
          "pt-3": previousAssistantPart(),
        }}
      >
        <div data-component="session-turn" class="min-w-0 w-full relative" style={{ height: "auto" }}>
          {input.children}
        </div>
      </div>
    )
  }

  const renderTimelineRow = (row: Accessor<TimelineRow.TimelineRow>, onSizeChange?: () => void) => {
    switch (row()._tag) {
      case "TurnGap":
        return <div data-timeline-row="TurnGap" aria-hidden="true" class="h-6" />
      case "CommentStrip": {
        const commentStripRow = row as Accessor<TimelineRowByTag<"CommentStrip">>
        const comments = createMemo(() =>
          getMsgParts(commentStripRow().userMessageID).flatMap((part) => MessageComment.fromPart(part) ?? []),
        )
        return (
          <TimelineRowFrame row={commentStripRow}>
            <div class="w-full px-4 md:px-5 pb-2">
              <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
                <div class="flex w-max min-w-full justify-end gap-2">
                  <For keyed={false} each={comments()}>
                    {(comment) => (
                      <div class="shrink-0 max-w-[260px] rounded-md border border-border-weak-base bg-background-stronger px-2.5 py-2">
                        <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
                          <FileIcon node={{ path: comment().path, type: "file" }} class="size-3.5 shrink-0" />
                          <span class="truncate">{getFilename(comment().path)}</span>
                          <Show when={comment().selection}>
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
                          {comment().comment}
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "UserMessage": {
        const userMessageRow = row as Accessor<TimelineRowByTag<"UserMessage">>
        const message = createMemo(() => {
          const m = messageByID().get(userMessageRow().userMessageID)
          if (m?.role === "user") return m
        })
        return (
          <TimelineRowFrame row={userMessageRow}>
            <Show when={message()}>
              {(message) => (
                <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
                  <div data-slot="session-turn-message-content" aria-live="off">
                    <Message
                      message={message()}
                      parts={getMsgParts(userMessageRow().userMessageID)}
                      actions={props.actions}
                    />
                  </div>
                </div>
              )}
            </Show>
          </TimelineRowFrame>
        )
      }
      case "TurnDivider": {
        const turnDividerRow = row as Accessor<TimelineRowByTag<"TurnDivider">>
        // D§3.6 / C4: terminal states are a centred hairline divider, a peer of the
        // "Worked for" fold row — never a card. "interrupted" durationMs (when derivable,
        // T8) reuses the same formatDuration voice as "Worked for {duration}".
        const label = () => {
          if (turnDividerRow().label === "compaction") return language.t("ui.messagePart.compaction")
          const durationMs = turnDividerRow().durationMs
          return typeof durationMs === "number"
            ? language.t("ui.message.interruptedDuration", { duration: formatDuration(durationMs) })
            : language.t("ui.message.interrupted")
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
        const assistantPartRow = row as Accessor<TimelineRowByTag<"AssistantPart">>
        return (
          <TimelineRowFrame row={assistantPartRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div
                data-slot="session-turn-assistant-content"
                aria-hidden={(() => {
                  // Solid 1 stringified the raw boolean; Solid 2 booleans mean
                  // attribute presence, so spell the strings out — one call,
                  // since workingTurn walks the turn's assistant messages.
                  const working = workingTurn(assistantPartRow().userMessageID)
                  return working == null ? undefined : working ? "true" : "false"
                })()}
              >
                {renderAssistantPartGroup(assistantPartRow, onSizeChange)}
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "Thinking": {
        const thinkingRow = row as Accessor<TimelineRowByTag<"Thinking">>
        return (
          <TimelineRowFrame row={thinkingRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineThinkingRow
                reasoningHeading={thinkingRow().reasoningHeading}
                showReasoningSummaries={settings.general.showReasoningSummaries()}
              />
            </div>
          </TimelineRowFrame>
        )
      }
      case "Retry": {
        const retryRow = row as Accessor<TimelineRowByTag<"Retry">>
        return (
          <TimelineRowFrame row={retryRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <ClaxedoSessionRetry status={sessionStatus()} show={activeMessageID() === retryRow().userMessageID} />
            </div>
          </TimelineRowFrame>
        )
      }
      case "TurnFold": {
        const turnFoldRow = row as Accessor<TimelineRowByTag<"TurnFold">>
        return (
          <TimelineRowFrame row={turnFoldRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TurnFoldRow
                durationMs={turnFoldRow().durationMs}
                folded={turnFoldRow().folded}
                tokens={turnFoldRow().tokens}
                cost={turnFoldRow().cost}
                running={turnFoldRow().running}
                showTokens={settings.general.timelineShowTurnTokens()}
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
        const diffSummaryRow = row as Accessor<TimelineRowByTag<"DiffSummary">>
        const undoTurn = () => {
          const revert = props.actions?.revert
          const id = sessionID()
          if (!revert || !id) return
          return Promise.resolve(revert({ sessionID: id, messageID: diffSummaryRow().userMessageID }))
            .then(() => showToast({ title: language.t("ui.message.revertMessage") }))
            .catch(() => showToast({ title: language.t("common.requestFailed"), variant: "error" }))
        }
        return (
          <TimelineRowFrame row={diffSummaryRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineDiffSummaryRow
                diffs={diffSummaryRow().diffs}
                onUndo={props.actions?.revert ? undoTurn : undefined}
              />
            </div>
          </TimelineRowFrame>
        )
      }
      case "Error": {
        const errorRow = row as Accessor<TimelineRowByTag<"Error">>
        return (
          <TimelineRowFrame row={errorRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <Show
                when={errorRow().recoveryClass}
                fallback={
                  <Card variant="error" class="error-card">
                    {/* Human sentence, never the raw provider bytes: this
                        fallback is what paints if the class is ever absent. */}
                    {errorRow().summary ?? errorRow().text}
                  </Card>
                }
              >
                {(kind) => (
                  <FirstTurnRecoveryCard
                    kind={kind()}
                    detail={errorRow().text}
                    summary={errorRow().summary}
                    error={errorRow().error}
                    providerID={errorRow().providerID}
                    modelID={errorRow().modelID}
                    onAction={(value) => props.onFirstTurnRecovery?.(value, errorRow().userMessageID)}
                  />
                )}
              </Show>
            </div>
          </TimelineRowFrame>
        )
      }
    }
  }

  function TimelineRowView(props: { row: TimelineRow.TimelineRow; onSizeChange?: () => void }) {
    return renderTimelineRow(() => props.row, props.onSizeChange)
  }

  function VirtualTimelineRow(props: { rowKey: string }) {
    let element: HTMLDivElement
    const initialItem = virtualItemByKey().get(props.rowKey)!
    const initialRow = timelineRowByKey().get(props.rowKey)!
    const item = createMemo(() => virtualItemByKey().get(props.rowKey) ?? initialItem)
    const row = createMemo(() => timelineRowByKey().get(props.rowKey) ?? initialRow)
    const asyncFile = () => {
      const value = row()
      if (value._tag !== "AssistantPart" || value.group.type !== "part") return false
      const part = getMsgPart(value.group.ref.messageID, value.group.ref.partID)
      return part?.type === "tool" && ["edit", "write", "apply_patch"].includes(part.tool)
    }
    const [ready, setReady] = createSignal(initialItem.size <= timelineFallbackItemSize || !asyncFile())

    let contentMeasureFrame: number | undefined
    onCleanup(() => contentMeasureFrame !== undefined && cancelAnimationFrame(contentMeasureFrame))
    onSettled(() => virtualizer.measureElement(element))

    createEffect(
      () => item().index,
      () => {
        virtualizer.measureElement(element)
      },
      { defer: true },
    )

    return (
      <div
        data-timeline-key={props.rowKey}
        data-timeline-row-rich-ready={ready() ? "true" : "false"}
        class="absolute left-0 w-full overflow-clip"
        style={{
          // Statics live in the class: this re-diffs per measurement wake.
          top: `${item().start}px`,
          height: `${item().size}px`,
          "overflow-clip-margin": row()._tag === "TurnGap" ? undefined : "0.5px",
        }}
      >
        <div
          ref={(value) => {
            element = value
          }}
          data-index={item().index}
          style={timelineRowFrameStyle({ size: item().size, minHeight: ready() ? undefined : initialItem.size })}
        >
          <TimelineRowView
            row={row()}
            onSizeChange={() => {
              setReady(true)
              if (contentMeasureFrame !== undefined) cancelAnimationFrame(contentMeasureFrame)
              contentMeasureFrame = scheduleConnectedMeasure(element, (el) => virtualizer.measureElement(el))
            }}
          />
        </div>
      </div>
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
            resolvePath={(path) => resolveTimelineFilePath(path, sdk.directory)}
            showItemInFolder={platform.showItemInFolder}
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
        class={[
          "absolute left-1/2 -translate-x-1/2 bottom-6 z-[60] transition-all duration-200 ease-out",
          {
            "opacity-100 translate-y-0 scale-100 pointer-events-auto": props.scroll.overflow && props.scroll.jump,
            "opacity-0 translate-y-2 scale-95 pointer-events-none": !props.scroll.overflow || !props.scroll.jump,
          },
        ]}
      >
        <button
          class="flex h-8 w-8 items-center justify-center rounded-full border border-border-weaker-base bg-surface-raised-stronger-non-alpha text-text-base cursor-pointer p-0 transition-colors hover:border-border-weak-base"
          aria-label={language.t("session.timeline.scrollToBottom")}
          onClick={props.onResumeScroll}
        >
          <Show when={sessionStatus().type === "busy"} fallback={<Icon name="scroll-to-latest" size="large" />}>
            <span class="tl-dot-wave" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </Show>
        </button>
      </div>
      <ScrollView
        data-slot="session-timeline-scroll"
        viewportRef={bindListRoot}
        onWheel={handleListWheel}
        onTouchStart={handleListTouchStart}
        onTouchMove={handleListTouchMove}
        onTouchEnd={handleListTouchEnd}
        onTouchCancel={handleListTouchEnd}
        onPointerDown={handleListPointerDown}
        onPointerMove={handleListPointerMove}
        onScroll={handleListScroll}
        onClick={props.onAutoScrollInteraction}
        class="relative min-w-0 w-full h-full"
        style={{
          "--sticky-accordion-top": showHeader() ? "48px" : "0px",
        }}
      >
        <Show when={showHeader()}>
          <div
            ref={(el) => {
              head = el
              updateTitleMetrics()
            }}
            data-session-title
            class={{
              "sticky top-0 z-30 bg-[linear-gradient(to_bottom,var(--background-stronger)_48px,transparent)]": true,
              "w-full": true,
              "pb-4": true,
              "pl-2 pr-3 md:pl-4 md:pr-3": true,
              "md:max-w-192 md:mx-auto 2xl:max-w-[880px]": props.centered,
            }}
          >
            <Show when={workingStatus() !== "hidden" && settings.general.showSessionProgressBar()}>
              <div
                data-component="session-progress"
                class="ui-session-progress"
                data-state={workingStatus()}
                aria-hidden="true"
              >
                <div
                  data-component="session-progress-bar"
                  style={{
                    background: tint() ?? "var(--icon-interactive-base)",
                    animation: `session-progress-whip ${bar.ms}ms infinite`,
                  }}
                />
              </div>
            </Show>
            <div class="h-12 w-full flex items-center justify-between gap-2">
              <div class="flex items-center gap-1 min-w-0 flex-1 pr-3">
                <div class="flex items-center min-w-0 grow-1">
                  <Show when={parentID()}>
                    <button
                      type="button"
                      data-slot="session-title-parent"
                      class="min-w-0 max-w-[40%] truncate text-14-medium text-text-weak transition-colors hover:text-text-base"
                      onClick={navigateParent}
                    >
                      {parentTitle()}
                    </button>
                    <span
                      data-slot="session-title-separator"
                      class="px-2 text-14-medium text-text-weak"
                      aria-hidden="true"
                    >
                      /
                    </span>
                  </Show>
                  <div
                    class="shrink-0 flex items-center justify-center overflow-hidden transition-[width,margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
                    style={{
                      width: working() ? "16px" : "0px",
                      "margin-right": working() ? "8px" : "0px",
                    }}
                    aria-hidden="true"
                  >
                    <Show when={workingStatus() !== "hidden"}>
                      <div
                        class={[
                          "transition-opacity duration-200 ease-out",
                          { "opacity-0": workingStatus() === "hiding" },
                        ]}
                      >
                        <Spinner class="size-4" style={{ color: tint() ?? "var(--icon-interactive-base)" }} />
                      </div>
                    </Show>
                  </div>
                  <Show when={childTitle() || title.editing}>
                    <Show
                      when={title.editing}
                      fallback={
                        <h1
                          data-slot="session-title-child"
                          data-subagent-child-heading={parentID() ? "" : undefined}
                          tabindex={parentID() ? -1 : undefined}
                          class="text-14-medium text-text-strong truncate grow-1 min-w-0"
                          onDblClick={openTitleEditor}
                        >
                          {childTitle()}
                        </h1>
                      }
                    >
                      <InlineInput
                        ref={(el) => {
                          titleRef = el
                        }}
                        data-slot="session-title-child"
                        value={title.draft}
                        disabled={titleMutation.isPending}
                        class="text-14-medium text-text-strong grow-1 min-w-0 rounded-md pl-1 -ml-1"
                        style={{ "--inline-input-shadow": "var(--shadow-xs-border-select)" }}
                        onInput={(event) => setTitle(storePath("draft", event.currentTarget.value))}
                        onKeyDown={(event) => {
                          event.stopPropagation()
                          if (event.key === "Enter") {
                            event.preventDefault()
                            void saveTitleEditor()
                            return
                          }
                          if (event.key === "Escape") {
                            event.preventDefault()
                            closeTitleEditor()
                          }
                        }}
                        onBlur={closeTitleEditor}
                      />
                    </Show>
                  </Show>
                </div>
              </div>
              <Show when={sessionID()} keyed>
                {(id) => (
                  <div class="shrink-0 flex items-center gap-3">
                    <Show when={!parentID()}>
                      <DropdownMenu
                        gutter={4}
                        placement="bottom-end"
                        open={title.menuOpen}
                        onOpenChange={(open) => {
                          setTitle(storePath("menuOpen", open))
                          if (open) return
                        }}
                      >
                        <DropdownMenu.Trigger
                          as={IconButton}
                          icon="dot-grid"
                          variant="ghost"
                          class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                          aria-label={language.t("common.moreOptions")}
                          aria-expanded={title.menuOpen == null ? undefined : title.menuOpen ? "true" : "false"}
                        />
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            style={{ "min-width": "160px" }}
                            onCloseAutoFocus={(event) => {
                              if (title.pendingRename) {
                                event.preventDefault()
                                setTitle(storePath("pendingRename", false))
                                openTitleEditor()
                              }
                            }}
                          >
                            <DropdownMenu.Item
                              onSelect={() => {
                                setTitle(storePath("pendingRename", true))
                                setTitle(storePath("menuOpen", false))
                              }}
                            >
                              <Icon name="edit" size="small" />
                              <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                            <DropdownMenu.Item onSelect={() => void archiveSession(id)}>
                              <Icon name="archive" size="small" />
                              <DropdownMenu.ItemLabel>{language.t("common.archive")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator />
                            <DropdownMenu.Item
                              onSelect={() => dialog.show(() => <DialogDeleteSession sessionID={id} title={titleLabel()} />)}
                            >
                              <Icon name="trash" size="small" />
                              <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Show>
        <Show when={ambientSubagents().length > 0}>
          <section
            aria-labelledby="background-subagents-heading"
            class="w-full px-4 pb-4 md:max-w-192 md:mx-auto 2xl:max-w-[880px]"
          >
            <h2 id="background-subagents-heading" class="pb-2 text-12-medium text-text-weak">
              Background subagents
            </h2>
            <SubagentChipRow subagents={ambientSubagents()} onOpen={openSubagent} />
          </section>
        </Show>
        <div
          data-timeline-virtual-content
          ref={(element) => {
            virtualContent = element
            props.setContentRef(element)
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
      </ScrollView>
    </div>
  )
}
