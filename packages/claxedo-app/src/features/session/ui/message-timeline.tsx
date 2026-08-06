import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
  mapArray,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { useNavigate } from "@solidjs/router"
import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip"
import { useMutation, useQuery } from "@tanstack/solid-query"
import { createVirtualizer, defaultRangeExtractor, elementScroll, type VirtualItem } from "@tanstack/solid-virtual"
import { observeElementOffsetReconnectAware } from "./message-timeline-observe-offset"
import { Accordion } from "@opencode-ai/ui/accordion"
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
  type UserActions,
} from "@/ui/session-kit"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ClaxedoSessionRetry } from "@/features/session/ui/components/claxedo-session-retry"
import { FirstTurnRecoveryCard } from "@/features/session/onboarding/first-turn-recovery-card"
import type { SessionErrorClass } from "@/features/session/onboarding/first-turn-recovery"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { TextReveal } from "@opencode-ai/ui/text-reveal"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import type {
  AssistantMessage,
  Message as MessageType,
  Part as PartType,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { Binary } from "@opencode-ai/core/util/binary"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { normalize } from "@/ui/session-kit"
import { useFileComponent } from "@opencode-ai/ui/context/file"
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
import { makeTimer } from "@solid-primitives/timer"
import {
  assistantMessageSettled,
  MessageComment,
  SummaryDiff,
  Timeline,
  TimelineRow,
  TimelineRowMap,
} from "./message-timeline.data"
import { registeredConversationSnapshot } from "../conversation/conversation-registry"
import { directorySessionCacheQueryOptions } from "../data/sync/queries"
import { agentListQuery } from "../data/query/directory"
import { useWorkspaceQuery } from "@/features/session/app-ports"
import { sessionRoute, workspaceSessionRoute } from "@/platform/identity/route"
import { isSessionTurnActive } from "../store/session-store"
import { useSessionSyncOptional } from "@/features/session/providers/session-sync"
import { removeDirectorySessionTree, updateDirectorySession } from "../data/sync/directory-session-cache"
import { mergeCanonicalSessionUpdate } from "../data/sync/session-list-events"
import {
  timelineInitialRevealShouldScroll,
  timelineInitialRevealVisibility,
  timelineInteractionPlan,
} from "./view-state"
import {
  applyTimelinePrependAnchor,
  captureTimelinePrependAnchor,
  type TimelinePrependAnchor,
} from "./timeline-prepend-anchor"
import { createTimelineResizeAnchor, filterVirtualIndexes, scheduleConnectedMeasure } from "./timeline-virtualization"
import { createTurnFoldStore } from "./turn-fold-store"
import { formatDuration } from "@/ui/session-kit"
import { installTimelineMermaid } from "./mermaid-timeline"
import {
  timelineAnchorClickTarget,
  timelineExternalSourceClickTarget,
  observeTimelineFileCandidates,
  timelineFileFocus,
  timelineFileTarget,
  resolveTimelinePath as resolveTimelineFilePath,
} from "./timeline-file-paths"
import { messageNavCurrentID, messageNavPreview, messageNavVisible } from "./message-nav-preview"
import "./message-nav-gutter.css"

installTimelineMermaid()

// Keep parity with the upstream session row model.
const emptyMessages: MessageType[] = []
const emptyParts: PartType[] = []
const emptyTools: ToolPart[] = []
const emptyAssistantMessages: AssistantMessage[] = []
const idle = { type: "idle" as const }

const sessionStatusQuery = (_sessionID: string | undefined, _client: ReturnType<typeof useSDK>["client"]) => ({
  queryKey: ["session-status", _sessionID],
  queryFn: async () => idle,
})

type FramedTimelineRow = Exclude<TimelineRow.TimelineRow, { _tag: "TurnGap" }>
type TimelineRowByTag<T extends TimelineRow.TimelineRow["_tag"]> = Extract<TimelineRow.TimelineRow, { _tag: T }>

const timelineFallbackItemSize = 60
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

function TimelineThinkingRow(props: { reasoningHeading?: string; showReasoningSummaries: boolean }) {
  const language = useLanguage()

  return (
    <div data-slot="session-turn-thinking">
      <TextShimmer text={language.t("ui.sessionTurn.status.thinking")} />
      <Show when={!props.showReasoningSummaries}>
        <TextReveal text={props.reasoningHeading} class="session-turn-thinking-heading" travel={25} duration={700} />
      </Show>
    </div>
  )
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}

function TurnFoldRow(props: {
  durationMs?: number
  folded: boolean
  onToggle: () => void
  tokens?: number
  cost?: number
  showTokens?: boolean
  running?: boolean
}) {
  // D§3.6: present tense while the turn is still working, past tense once it settles.
  const label = () => {
    const verb = props.running ? "Working" : "Worked"
    return typeof props.durationMs === "number" ? `${verb} for ${formatDuration(props.durationMs)}` : verb
  }
  const footer = () => {
    if (!props.showTokens || !props.tokens) return undefined
    const parts = [`${formatTokenCount(props.tokens)} tokens`]
    if (typeof props.cost === "number" && props.cost > 0) parts.push(`$${props.cost.toFixed(2)}`)
    return parts.join(" · ")
  }
  return (
    <div data-component="turn-fold" class="w-full">
      <button
        type="button"
        aria-expanded={!props.folded}
        onClick={(event) => {
          event.stopPropagation()
          props.onToggle()
        }}
        class="group/turn-fold flex items-center gap-1.5 h-8 rounded-[4px] px-1 -mx-1 text-text-weak hover:text-text-strong focus-visible:text-text-strong focus-visible:outline-none transition-colors"
      >
        <span class="text-14-medium tabular-nums">{label()}</span>
        <span
          class="inline-flex items-center opacity-60 group-hover/turn-fold:opacity-100 transition-transform duration-300"
          style={{ transform: props.folded ? "rotate(0deg)" : "rotate(90deg)" }}
        >
          <Icon name="chevron-right" size="small" />
        </span>
        <Show when={footer()}>
          <span class="ml-auto text-12-regular text-text-weaker tabular-nums">{footer()}</span>
        </Show>
      </button>
      <div class="h-px w-full bg-border-weak-base" aria-hidden="true" />
    </div>
  )
}

function TimelineDiffSummaryRow(props: { diffs: SummaryDiff[]; onUndo?: () => Promise<unknown> | void }) {
  const language = useLanguage()
  const maxFiles = 3
  const [state, setState] = createStore({
    showAll: false,
    expanded: [] as string[],
    undoing: false,
  })
  const showAll = () => state.showAll
  const expanded = () => state.expanded
  const overflow = createMemo(() => Math.max(0, props.diffs.length - maxFiles))
  const visible = createMemo(() => (showAll() ? props.diffs : props.diffs.slice(0, maxFiles)))

  // Undo the whole turn's edits via the git-snapshot revert (T9, D§3.9).
  const undo = () => {
    if (!props.onUndo || state.undoing) return
    setState("undoing", true)
    void Promise.resolve()
      .then(() => props.onUndo!())
      .finally(() => setState("undoing", false))
  }

  return (
    <div
      data-slot="session-turn-diffs"
      data-component="session-turn-diffs-group"
      data-show-all={showAll() || undefined}
    >
      <div data-slot="session-turn-diffs-header">
        <span data-slot="session-turn-diffs-label">
          {props.diffs.length} {language.t("ui.sessionTurn.diffs.changed")}{" "}
          {language.t(props.diffs.length === 1 ? "ui.common.file.one" : "ui.common.file.other")}
        </span>
        <DiffChanges changes={props.diffs} />
        <Show when={props.onUndo}>
          <button
            type="button"
            data-slot="session-turn-diffs-undo"
            class="text-12-medium text-text-weak hover:text-text-strong active:scale-[0.96] transition-transform disabled:opacity-50 cursor-pointer bg-transparent border-none px-1"
            disabled={state.undoing}
            onClick={(event) => {
              event.stopPropagation()
              undo()
            }}
          >
            {language.t("ui.message.revertMessage")}
          </button>
        </Show>
        <Show when={overflow() > 0}>
          <span data-slot="session-turn-diffs-toggle" onClick={() => setState("showAll", !showAll())}>
            {showAll() ? language.t("ui.sessionTurn.diffs.showLess") : language.t("ui.sessionTurn.diffs.showAll")}
          </span>
        </Show>
      </div>
      <div data-component="session-turn-diffs-content">
        <Accordion
          multiple
          style={{ "--sticky-accordion-offset": "44px" }}
          value={expanded()}
          onChange={(value) => setState("expanded", Array.isArray(value) ? value : value ? [value] : [])}
        >
          <For each={visible()}>
            {(diff) => {
              const opened = createMemo(() => expanded().includes(diff.file))

              return (
                <Accordion.Item value={diff.file}>
                  <StickyAccordionHeader>
                    <Accordion.Trigger>
                      <DiffHoverCard diff={diff}>
                        <div data-slot="session-turn-diff-trigger">
                          <span data-slot="session-turn-diff-path" data-path={diff.file}>
                            <Show when={diff.file.includes("/")}>
                              <span data-slot="session-turn-diff-directory">{`\u202A${getDirectory(diff.file)}\u202C`}</span>
                            </Show>
                            <span data-slot="session-turn-diff-filename">{getFilename(diff.file)}</span>
                          </span>
                          <div data-slot="session-turn-diff-meta">
                            <span data-slot="session-turn-diff-changes">
                              <DiffChanges changes={diff} />
                            </span>
                            <span data-slot="session-turn-diff-chevron">
                              <Icon name="chevron-down" size="small" />
                            </span>
                          </div>
                        </div>
                      </DiffHoverCard>
                    </Accordion.Trigger>
                  </StickyAccordionHeader>
                  <Accordion.Content>
                    <Show when={opened()}>
                      <TimelineDiffView diff={diff} />
                    </Show>
                  </Accordion.Content>
                </Accordion.Item>
              )
            }}
          </For>
        </Accordion>
        <Show when={!showAll() && overflow() > 0}>
          <div data-slot="session-turn-diffs-more" onClick={() => setState("showAll", true)}>
            {language.t("ui.sessionTurn.diffs.more", { count: String(overflow()) })}
          </div>
        </Show>
      </div>
    </div>
  )
}

function TimelineDiffView(props: { diff: SummaryDiff }) {
  const fileComponent = useFileComponent()
  const view = normalize(props.diff)

  return (
    <div data-slot="session-turn-diff-view" data-scrollable>
      <Dynamic component={fileComponent} mode="diff" fileDiff={view.fileDiff} />
    </div>
  )
}

// Hover diff popover (T10, D§3.10): 800ms hover on a file row floats a diff preview.
function DiffHoverCard(props: { diff: SummaryDiff; children: JSX.Element }) {
  return (
    <KobalteTooltip openDelay={800} closeDelay={100} placement="top" gutter={8}>
      <KobalteTooltip.Trigger as="div" class="min-w-0 w-full">
        {props.children}
      </KobalteTooltip.Trigger>
      <KobalteTooltip.Portal>
        <KobalteTooltip.Content class="z-[95] max-w-[min(560px,80vw)] max-h-80 overflow-auto rounded-[10px] border-[0.5px] border-border-weak-base bg-background-stronger shadow-xl">
          <div class="flex items-center justify-between gap-3 px-3 py-2 border-b-[0.5px] border-border-weak-base text-12-regular text-text-weak">
            <span class="truncate">{props.diff.file}</span>
            <DiffChanges changes={props.diff} />
          </div>
          <TimelineDiffView diff={props.diff} />
        </KobalteTooltip.Content>
      </KobalteTooltip.Portal>
    </KobalteTooltip>
  )
}

export function MessageTimeline(props: {
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
  setRevealMessage?: (fn: (id: string) => void) => void
  setScrollToEnd?: (fn: () => void) => void
  setHistoryAnchor?: (handlers: { capture: () => void; restore: () => void }) => void
  onFirstTurnRecovery?: (kind: SessionErrorClass, userMessageID: string) => unknown
  firstTurnRecovery?: boolean
  title: () => string | undefined
}) {
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
  const turnFold = createTurnFoldStore(ownerSessionKey)
  const platform = usePlatform()
  const claxedoState = useClaxedoState()
  const paneId = usePaneId()

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
  const handleTimelinePathClick = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    const target = event.target instanceof Element ? event.target : null
    const selection = typeof window !== "undefined" ? window.getSelection() : null
    if (selection && !selection.isCollapsed) return // don't hijack a text-selection click
    if (target?.closest("a[href]")) return // anchors → capture handler below
    const raw = target?.closest('[data-inline-code-kind="path"]')?.textContent?.trim()
    if (!raw || !fileFocus(raw)) return
    event.preventDefault()
    openFileInPanel(raw)
  }
  // Capture phase runs before the link's default action (see above).
  const registerTimelineRoot = (el: HTMLDivElement) => {
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
    const stopCandidatePromotion = observeTimelineFileCandidates(el, sdk.directory, (query) =>
      sdk.client.find.files({ query, dirs: "false" }).then(
        (response) => response.data ?? [],
        () => [],
      ),
    )
    onCleanup(() => {
      el.removeEventListener("click", onCapture, { capture: true })
      stopCandidatePromotion()
    })
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
  const directoryAgentsQuery = (
    _baseUrl: string | undefined,
    directory: string,
    client: ReturnType<typeof useSDK>["client"],
  ) => {
    const request = platform.fetch ?? fetch
    return {
      ...agentListQuery({
        baseUrl: sdk.url,
        directory,
        request,
        workspace: sdk.workspace(directory),
        client,
      }),
      workspaceId: sdk.workspace(directory)?.workspaceId,
    }
  }
  const directorySessionCacheQuery = (directory: string) => directorySessionCacheQueryOptions({ directory })
  const sessionConversation = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return registeredConversationSnapshot(id)
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
  const sessionStatus = createMemo(() => props.status() ?? idle)
  const sessionStatusQueryResult = useQuery(() => sessionStatusQuery(sessionID(), sdk.client))
  const working = createMemo(() => isSessionTurnActive({ status: sessionStatus() }))
  // agentListQuery routes to the workspace runtime for relay-backed scopes — gate
  // it on the authority so it cannot fire while that workspace is offline. Local
  // scopes (`workspace()` undefined) are a no-op gate, preserving loopback.
  const directoryAgentsQueryResult = useWorkspaceQuery(() => directoryAgentsQuery(sdk.url, sdk.directory, sdk.client))
  const directorySessionCacheQueryResult = useQuery(() => directorySessionCacheQuery(sdk.directory))
  const directorySessionRows = createMemo(() => directorySessionCacheQueryResult.data?.session ?? [])
  const directorySession = (sessionID: string | undefined) =>
    sessionID ? directorySessionRows().find((session) => session.id === sessionID) : undefined
  const tint = createMemo(() => messageAgentColor(sessionMessages(), directoryAgentsQueryResult.data ?? []))

  const [timeoutDone, setTimeoutDone] = createSignal(true)

  const workingStatus = createMemo<"hidden" | "showing" | "hiding">((prev) => {
    if (working()) return "showing"
    if (prev === "showing" || !timeoutDone()) return "hiding"
    return "hidden"
  })

  createEffect(() => {
    if (workingStatus() !== "hiding") return

    setTimeoutDone(false)
    makeTimer(() => setTimeoutDone(true), 260, setTimeout)
  })

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
  const titleValue = createMemo(props.title)
  const titleLabel = createMemo(() => sessionTitle(titleValue()))
  const parentID = createMemo(() => info()?.parentID)
  const parent = createMemo(() => {
    const id = parentID()
    if (!id) return
    return directorySession(id)
  })
  const parentConversation = createMemo(() => {
    const id = parentID()
    if (!id) return
    return registeredConversationSnapshot(id)
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

  const messageRowMemos = createMemo(
    mapArray(
      () => props.userMessages,
      (userMessage, indexAccessor) => {
        return createMemo((previous: TimelineRow.TimelineRow[] | undefined) => {
          const rows = Timeline.constructMessageRows(
            userMessage,
            getMsgParts,
            assistantMessagesByParent().get(userMessage.id) ?? emptyAssistantMessages,
            indexAccessor(),
            settings.general.showReasoningSummaries(),
            sessionStatus().type,
            activeMessageID() === userMessage.id,
            props.firstTurnRecovery !== false && indexAccessor() === 0,
            (userMessageID) => turnFold.isFolded(userMessageID),
            settings.general.timelineFoldWhileRunning(),
            info()?.lastTurn,
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
  let prependAnchorFrame: number | undefined
  let prependLoading = false
  const clearPrependAnchor = () => {
    prependLoading = false
    prependAnchor = undefined
    if (prependAnchorFrame === undefined) return
    cancelAnimationFrame(prependAnchorFrame)
    prependAnchorFrame = undefined
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
    if (prependAnchorFrame !== undefined) cancelAnimationFrame(prependAnchorFrame)
    let frames = 0
    let stable = 0
    const apply = () => {
      prependAnchorFrame = undefined
      if (applyTimelinePrependAnchor(root, anchor) === "adjusted") {
        stable = 0
      } else {
        stable += 1
      }
      frames += 1
      if (stable >= 30 || frames >= 180) {
        prependAnchor = undefined
        return
      }
      prependAnchorFrame = requestAnimationFrame(apply)
    }
    prependAnchorFrame = requestAnimationFrame(apply)
  }

  const [toolOpen, setToolOpen] = createStore<Record<string, boolean | undefined>>(cached?.toolOpen ?? {})
  const initialMeasurements = cached?.measurements
  const [renderOverscan, setRenderOverscan] = createSignal(initialMeasurements?.length ? 6 : 50)
  const [initialRevealReady, setInitialRevealReady] = createSignal(!props.shouldAnchorBottom())
  const prepareScrollOverscan = () => {
    if (renderOverscan() < 50) setRenderOverscan(50)
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
    observeElementOffset: observeElementOffsetReconnectAware,
    initialOffset: () => (props.shouldAnchorBottom() ? Number.MAX_SAFE_INTEGER : 0),
    initialMeasurementsCache: initialMeasurements,
    estimateSize: () => timelineFallbackItemSize,
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
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    overscan: 50,
    paddingEnd: 64,
    rangeExtractor: (range) => {
      const id = activeMessageID()
      const active = id ? timelineRows().findLastIndex((row) => "userMessageID" in row && row.userMessageID === id) : -1
      const indexes = defaultRangeExtractor({ ...range, overscan: renderOverscan() })
      return filterVirtualIndexes(
        [...new Set([...resizeAnchor.pinnedIndexes(), ...indexes, ...(active < 0 ? [] : [active])])].sort(
          (a, b) => a - b,
        ),
        range.count,
      )
    },
  })
  resizeAnchor.install({
    virtualizer,
    root: listRoot,
    shouldAnchorBottom: props.shouldAnchorBottom,
    hasScrollGesture: props.hasScrollGesture,
  })
  const timelineRowByKey = createMemo(() => new Map(timelineRows().map((row) => [TimelineRow.key(row), row] as const)))
  const virtualItemByKey = createMemo(
    () => new Map(virtualizer.getVirtualItems().map((item) => [item.key, item] as const)),
  )
  const virtualRowKeys = createMemo(() => virtualizer.getVirtualItems().map((item) => item.key as string))
  const messageRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    timelineRows().forEach((row, index) => {
      if (!("userMessageID" in row)) return
      if (result.has(row.userMessageID)) return
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
    props.setRevealMessage?.((id) => {
      const index = messageRowIndex().get(id)
      if (index === undefined) return
      virtualizer.scrollToIndex(index, { align: "center" })
    })
    props.setScrollToEnd?.(() => virtualizer.scrollToEnd())
    props.setHistoryAnchor?.({ capture: capturePrependAnchor, restore: restorePrependAnchor })
  })

  const scheduleInitialReveal = () => {
    if (!props.shouldAnchorBottom()) {
      setInitialRevealReady(true)
      return
    }

    let frames = 8
    const settle = () => {
      if (
        timelineInitialRevealShouldScroll({
          hasScrollGesture: props.hasScrollGesture(),
          shouldAnchorBottom: props.shouldAnchorBottom(),
        })
      )
        virtualizer.scrollToEnd()
      frames -= 1
      if (frames <= 0) {
        setInitialRevealReady(true)
        return
      }
      requestAnimationFrame(settle)
    }
    requestAnimationFrame(settle)
  }

  onMount(() => {
    const expand = () => {
      const next = Math.min(50, renderOverscan() + 8)
      setRenderOverscan(next)
      if (next < 50) requestAnimationFrame(() => setTimeout(expand, 0))
    }
    requestAnimationFrame(() => {
      if (props.shouldAnchorBottom()) virtualizer.scrollToEnd()
      scheduleInitialReveal()
      if (renderOverscan() < 50) setTimeout(expand, 0)
    })
  })

  let bottomAnchorSessionKey = ""
  let bottomAnchorFrame: number | undefined

  const maybeAnchorBottom = () => {
    const key = sessionKey()
    if (bottomAnchorSessionKey === key) return
    if (timelineRows().length === 0) return
    bottomAnchorSessionKey = key
    if (!props.shouldAnchorBottom()) return
    if (bottomAnchorFrame !== undefined) cancelAnimationFrame(bottomAnchorFrame)
    clearPrependAnchor()
    if (prependAnchorFrame !== undefined) cancelAnimationFrame(prependAnchorFrame)
    bottomAnchorFrame = requestAnimationFrame(() => {
      bottomAnchorFrame = undefined
      if (sessionKey() !== key) return
      virtualizer.scrollToEnd()
    })
  }

  let measuredSessionKey = sessionKey()
  createEffect(() => {
    const key = sessionKey()
    timelineRows().length
    if (measuredSessionKey !== key) {
      measuredSessionKey = key
      virtualizer.measure()
    }
    maybeAnchorBottom()
  })

  onCleanup(() => {
    timelineCache.delete(ownerSessionKey)
    timelineCache.set(ownerSessionKey, { measurements: virtualizer.takeSnapshot(), toolOpen: { ...toolOpen } })
    turnFold.persist()
    while (timelineCache.size > 16) timelineCache.delete(timelineCache.keys().next().value!)
    if (bottomAnchorFrame !== undefined) cancelAnimationFrame(bottomAnchorFrame)
    resizeAnchor.dispose()
    props.setRevealMessage?.(() => {})
    props.setScrollToEnd?.(() => {})
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

  const updateTitleMetrics = () => {
    if (!head || head.clientWidth <= 0) return
    setBar("ms", pace(head.clientWidth))
  }

  createResizeObserver(() => head, updateTitleMetrics)

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
      setTitle("editing", false)
    },
    onError: (err) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(err),
      })
    },
  }))

  createEffect(
    on(
      sessionKey,
      () =>
        setTitle({
          draft: "",
          editing: false,
          menuOpen: false,
          pendingRename: false,
        }),
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [parentID(), childTaskDescription()] as const,
      ([id, description]) => {
        if (!id || description) return
        if (parentMessages().length > 0) return
        void Promise.resolve(sessionSync?.syncSession?.(id)).catch(() => undefined)
      },
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    const patch = openTitleEditorPatch({
      hasSession: !!sessionID(),
      isChild: !!parentID(),
      currentTitle: titleLabel(),
    })
    if (!patch) return
    setTitle(patch)
    requestAnimationFrame(() => {
      titleRef?.focus()
      titleRef?.select()
    })
  }

  const closeTitleEditor = () => {
    if (titleMutation.isPending) return
    setTitle("editing", false)
  }

  const saveTitleEditor = () => {
    const id = sessionID()
    if (!id) return
    if (titleMutation.isPending) return

    const decision = resolveTitleSave({ draft: title.draft, currentTitle: titleLabel() })
    if (!decision.commit) {
      setTitle("editing", false)
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
    const id = parentID()
    if (!id) return
    navigate(sessionRoute(id))
  }

  function DialogDeleteSession(props: { sessionID: string }) {
    const name = createMemo(
      () => sessionTitle(directorySession(props.sessionID)?.title) ?? language.t("command.session.new"),
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
    sessionStatus().type !== "idle" && activeMessageID() === userMessageID && !turnSettled(userMessageID)

  const turnDurationMs = (userMessageID: string) => {
    const message = messageByID().get(userMessageID)
    if (!message || message.role !== "user") return
    return Timeline.turnDurationMs(message, turnAssistantMessages(userMessageID))
  }

  const turnInterrupted = (userMessageID: string) =>
    Timeline.turnInterrupted(
      turnAssistantMessages(userMessageID),
      info()?.lastTurn,
    )

  const assistantCopyPartID = (userMessageID: string) => {
    if (workingTurn(userMessageID)) return null
    const messages = assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages

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
      return <SubagentChipRow parts={members()} onOpen={(childSessionId) => navigate(sessionRoute(childSessionId))} />
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
                  onToolOpenChange={(open) => setToolOpen(member.part.id, open)}
                  deferToolContent={false}
                  virtualizeDiff={false}
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
                onToolOpenChange={(open) => setToolOpen(part().id, open)}
                deferToolContent={false}
                virtualizeDiff={false}
                onContentRendered={onSizeChange}
              />
            )}
          </Show>
        )}
      </Show>
    )
  }

  function TimelineRowFrame(input: { row: Accessor<FramedTimelineRow>; children: JSX.Element }) {
    const anchor = () => {
      const row = input.row()
      return row._tag === "CommentStrip" || (row._tag === "UserMessage" && row.anchor)
    }
    const previousAssistantPart = () => {
      const row = input.row()
      return row._tag === "AssistantPart" && row.previousAssistantPart
    }

    return (
      <div
        id={anchor() ? props.anchor(input.row().userMessageID) : undefined}
        data-message-id={input.row().userMessageID}
        data-timeline-row={input.row()._tag}
        classList={{
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
                  <Index each={comments()}>
                    {(comment) => (
                      <div class="shrink-0 max-w-[260px] rounded-[6px] border border-border-weak-base bg-background-stronger px-2.5 py-2">
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
                  </Index>
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
                aria-hidden={workingTurn(assistantPartRow().userMessageID)}
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
    onMount(() => virtualizer.measureElement(element))

    createEffect(
      on(
        () => item().index,
        () => {
          virtualizer.measureElement(element)
        },
        { defer: true },
      ),
    )

    return (
      <div
        data-timeline-key={props.rowKey}
        style={{
          position: "absolute",
          top: `${item().start}px`,
          left: "0",
          width: "100%",
          height: `${item().size}px`,
          overflow: "clip",
          "overflow-clip-margin": row()._tag === "TurnGap" ? undefined : "0.5px",
        }}
      >
        <div
          ref={(value) => {
            element = value
          }}
          data-index={item().index}
          style={{ "min-height": ready() ? undefined : `${initialItem.size}px` }}
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
      style={{ visibility: timelineInitialRevealVisibility({ ready: initialRevealReady() }) }}
      onClick={handleTimelinePathClick}
      onContextMenu={handleTimelineContextMenu}
    >
      <Show when={contextMenu()}>
        {(menu) => (
          <>
            <div
              class="fixed inset-0 z-[90]"
              onClick={() => setContextMenu(undefined)}
              onContextMenu={(e) => {
                e.preventDefault()
                setContextMenu(undefined)
              }}
            />
            <div
              class="theme-overlay-surface fixed z-[91] min-w-40 rounded-[10px] border-[0.5px] border-border-weak-base bg-background-stronger p-1 shadow-lg"
              style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
            >
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-[6px] px-2 h-9 text-13-regular text-text-base hover:bg-surface-base-active"
                onClick={() => {
                  openFileInPanel(menu().path)
                  setContextMenu(undefined)
                }}
              >
                <Icon name="open-file" size="small" /> Open
              </button>
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-[6px] px-2 h-9 text-13-regular text-text-base hover:bg-surface-base-active"
                onClick={() => {
                  void navigator.clipboard?.writeText(resolveTimelineFilePath(menu().path, sdk.directory))
                  setContextMenu(undefined)
                }}
              >
                <Icon name="copy" size="small" /> Copy path
              </button>
              <Show when={platform.showItemInFolder}>
                <button
                  type="button"
                  class="flex w-full items-center gap-2 rounded-[6px] px-2 h-9 text-13-regular text-text-base hover:bg-surface-base-active"
                  onClick={() => {
                    void platform.showItemInFolder?.(resolveTimelineFilePath(menu().path, sdk.directory))
                    setContextMenu(undefined)
                  }}
                >
                  <Icon name="folder" size="small" /> Reveal in Finder
                </button>
              </Show>
            </div>
          </>
        )}
      </Show>
      <Show when={messageNavVisible((props.navMessages ?? props.userMessages).length) && props.onMessageSelect}>
        {/*
          Query container for the rail. It sizes to the timeline but holds no
          fixed-position descendants, so `container-type` cannot re-root the
          context menu the way declaring it on the timeline root would.
        */}
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
        class="absolute left-1/2 -translate-x-1/2 bottom-6 z-[60] pointer-events-none transition-all duration-200 ease-out"
        classList={{
          "opacity-100 translate-y-0 scale-100": props.scroll.overflow && props.scroll.jump,
          "opacity-0 translate-y-2 scale-95 pointer-events-none": !props.scroll.overflow || !props.scroll.jump,
        }}
      >
        <button
          class="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border-weaker-base bg-surface-raised-stronger-non-alpha text-text-base cursor-pointer p-0 transition-colors hover:border-border-weak-base"
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
            classList={{
              "sticky top-0 z-30 bg-[linear-gradient(to_bottom,var(--background-stronger)_48px,transparent)]": true,
              "w-full": true,
              "pb-4": true,
              "pl-2 pr-3 md:pl-4 md:pr-3": true,
              "md:max-w-192 md:mx-auto 2xl:max-w-[880px]": props.centered,
            }}
          >
            <Show when={workingStatus() !== "hidden" && settings.general.showSessionProgressBar()}>
              <div data-component="session-progress" data-state={workingStatus()} aria-hidden="true">
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
                        class="transition-opacity duration-200 ease-out"
                        classList={{ "opacity-0": workingStatus() === "hiding" }}
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
                        class="text-14-medium text-text-strong grow-1 min-w-0 rounded-[6px] pl-1 -ml-1"
                        style={{ "--inline-input-shadow": "var(--shadow-xs-border-select)" }}
                        onInput={(event) => setTitle("draft", event.currentTarget.value)}
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
                          setTitle("menuOpen", open)
                          if (open) return
                        }}
                      >
                        <DropdownMenu.Trigger
                          as={IconButton}
                          icon="dot-grid"
                          variant="ghost"
                          class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                          aria-label={language.t("common.moreOptions")}
                          aria-expanded={title.menuOpen}
                        />
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            style={{ "min-width": "160px" }}
                            onCloseAutoFocus={(event) => {
                              if (title.pendingRename) {
                                event.preventDefault()
                                setTitle("pendingRename", false)
                                openTitleEditor()
                              }
                            }}
                          >
                            <DropdownMenu.Item
                              onSelect={() => {
                                setTitle("pendingRename", true)
                                setTitle("menuOpen", false)
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
                              onSelect={() => dialog.show(() => <DialogDeleteSession sessionID={id} />)}
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
              class="h-16 absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${virtualizer.getTotalSize() - 64}px)` }}
            />
          </Show>
        </div>
      </ScrollView>
    </div>
  )
}
