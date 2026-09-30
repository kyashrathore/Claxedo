import { claxedoToolName, toolNameAliases, toolOpensByDefault } from "@claxedo/agent-runtime-contract"
import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onMount,
  Show,
  Switch,
  onCleanup,
  Index,
  type JSX,
  type ComponentProps,
} from "solid-js"
import { createStore } from "solid-js/store"
import stripAnsi from "strip-ansi"
import { Dynamic } from "solid-js/web"
import type {
  AgentFileLocation,
  AgentAgentPart,
  AgentAssistantMessage,
  AgentContentPart,
  AgentFilePart,
  AgentPresentationMessage,
  AgentQuestionAnswer,
  AgentQuestionInfo,
  AgentTextPart,
  AgentTodo,
  AgentToolPart,
  AgentUserMessage,
} from "@claxedo/agent-runtime-contract"
import { useData } from "./data"
import { useFileComponent, useDialog, Accordion, StickyAccordionHeader, Collapsible, FileIcon, Icon, Checkbox, DiffChanges, ImagePreview, Tooltip, IconButton, Button, TextShimmer, type IconProps } from "@/ui"
import { getDirectory as _getDirectory, getFilename, checksum } from "@/ui/utils"
import { copyText } from "@/lib/clipboard"
import { type TranscriptI18n, useTranscriptI18n } from "./i18n"
import { BasicTool, GenericTool, shellExitCode, ToolExitCode } from "./basic-tool"
import { ScrollableOutput } from "./scrollable-output"
import { groupParts, isHiddenTool, isPendingQuestion, isSubagentToolPart, type PartGroup, type PartRef } from "@claxedo/agent-runtime-contract/turn-fold"
import { sameGroups } from "./same-groups"
import { workGroupActiveLabel, workGroupIcon, workGroupSummary, workGroupTitle } from "./work-group-summary"
import { SubagentChipRow } from "./subagent-chip"
import { dispatchPlanOpen, readPlanToolInput } from "./plan-tool"
import { ToolErrorCard } from "./tool-error-card"
import { ClaxedoTool } from "./claxedo-tool"
import { claxedoToolTitle, claxedoToolView } from "./claxedo-tool-view"
import { QuestionCard } from "./question-card"
import { isQuestionDeclined } from "./question-result"
import { Markdown } from "./markdown"
import { formatDuration } from "./format-duration"
import { localPreviewUrl } from "./local-preview"
import { stripShellWrapper } from "./shell-wrapper"
import { AnimatedCountList } from "./tool-count-summary"
import { ToolStatusTitle } from "./tool-status-title"
import { patchFiles } from "./apply-patch-file"
import { animate } from "motion"
import { useLocation } from "@solidjs/router"
import { attached, inline, kind } from "./message-file"
import { MessageDivider } from "./message-divider"
import { NoticePartDisplay } from "./notice-part"
import { isRetractedPart, RetractedPartDisplay } from "./retracted-part"
import { DiagnosticsDisplay, getDiagnostics } from "./tool-diagnostics"
import { readPartText } from "./message-part-text"
import { shouldRenderUserMarkdown } from "./user-message-markdown"
import { handleTranscriptLinkClick, transcriptLinkHref, transcriptLinks } from "./transcript-link"

function ShellSubmessage(props: { text: string; animate?: boolean }) {
  let widthRef: HTMLSpanElement | undefined
  let valueRef: HTMLSpanElement | undefined

  onMount(() => {
    if (!props.animate) return
    requestAnimationFrame(() => {
      if (widthRef) {
        animate(widthRef, { width: "auto" }, { type: "spring", visualDuration: 0.25, bounce: 0 })
      }
      if (valueRef) {
        animate(valueRef, { opacity: 1, filter: "blur(0px)" }, { duration: 0.32, ease: [0.16, 1, 0.3, 1] })
      }
    })
  })

  return (
    <span data-component="shell-submessage">
      <span ref={widthRef} data-slot="shell-submessage-width" style={{ width: props.animate ? "0px" : undefined }}>
        <span data-slot="basic-tool-tool-subtitle">
          <span
            ref={valueRef}
            data-slot="shell-submessage-value"
            style={props.animate ? { opacity: 0, filter: "blur(2px)" } : undefined}
          >
            {props.text}
          </span>
        </span>
      </span>
    </span>
  )
}

export interface MessageProps {
  message: AgentPresentationMessage
  parts: AgentContentPart[]
  actions?: UserActions
  showAssistantCopyPartId?: string | null
  showReasoningSummaries?: boolean
}

export type SessionAction = (input: { sessionId: string; messageId: string }) => Promise<void> | void

export type UserActions = {
  fork?: SessionAction
  revert?: SessionAction
}

export interface MessagePartProps {
  part: AgentContentPart
  message: AgentPresentationMessage
  hideDetails?: boolean
  defaultOpen?: boolean
  toolOpen?: boolean
  onToolOpenChange?: (open: boolean) => void
  toolRevealed?: boolean
  onToolRevealedChange?: (revealed: boolean) => void
  deferToolContent?: boolean
  virtualizeDiff?: boolean
  onContentRendered?: () => void
  showAssistantCopyPartId?: string | null
  turnDurationMs?: number
  turnInterrupted?: boolean
}

const virtualizedDiffViewport: JSX.CSSProperties = {
  "max-height": "min(480px, 50vh)",
  overflow: "auto",
  contain: "layout paint",
}

function MessageActionButton(
  props: Pick<ComponentProps<"button">, "disabled" | "onMouseDown" | "onClick" | "aria-label"> & {
    icon: "check" | "copy" | "reset"
    label: JSX.Element
  },
) {
  return (
    <Tooltip value={props.label} placement="top" gutter={4}>
      <IconButton
        icon={<Icon name={props.icon} size="small" />}
        size="normal"
        variant="ghost"
        disabled={props.disabled}
        onMouseDown={props.onMouseDown}
        onClick={props.onClick}
        aria-label={props["aria-label"]}
      />
    </Tooltip>
  )
}

export type PartComponent = Component<MessagePartProps>

export const PART_MAPPING: Record<string, PartComponent | undefined> = {}

function wrongPartType(expected: AgentContentPart["type"], part: AgentContentPart): Error {
  return new Error(`the "${expected}" renderer received a "${part.type}" part`)
}

const TEXT_RENDER_PACE_MS = 24
const TEXT_RENDER_IMMEDIATE = 512
const TEXT_RENDER_SNAP = /[\s.,!?;:)\]]/

function step(size: number) {
  if (size <= 12) return 2
  if (size <= 48) return 4
  if (size <= 96) return 8
  return Math.min(256, Math.ceil(size / 4))
}

function next(text: string, start: number) {
  const end = Math.min(text.length, start + step(text.length - start))
  const max = Math.min(text.length, end + 8)
  for (let i = end; i < max; i++) {
    if (TEXT_RENDER_SNAP.test(text[i] ?? "")) return i + 1
  }
  return end
}

function createPacedValue(getValue: () => string, live?: () => boolean) {
  const [value, setValue] = createSignal(getValue())
  let shown = getValue()
  let timeout: ReturnType<typeof setTimeout> | undefined

  const clear = () => {
    if (!timeout) return
    clearTimeout(timeout)
    timeout = undefined
  }

  const sync = (text: string) => {
    shown = text
    setValue(text)
  }

  const run = () => {
    timeout = undefined
    const text = getValue()
    if (!live?.()) {
      sync(text)
      return
    }
    if (!text.startsWith(shown) || text.length <= shown.length) {
      sync(text)
      return
    }
    if (text.length - shown.length <= TEXT_RENDER_IMMEDIATE) {
      sync(text)
      return
    }
    const end = next(text, shown.length)
    sync(text.slice(0, end))
    if (end < text.length) timeout = setTimeout(run, TEXT_RENDER_PACE_MS)
  }

  createEffect(() => {
    const text = getValue()
    if (!live?.()) {
      clear()
      sync(text)
      return
    }
    if (!text.startsWith(shown) || text.length < shown.length) {
      clear()
      sync(text)
      return
    }
    if (text.length - shown.length <= TEXT_RENDER_IMMEDIATE) {
      clear()
      sync(text)
      return
    }
    if (text.length === shown.length || timeout) return
    timeout = setTimeout(run, TEXT_RENDER_PACE_MS)
  })

  onCleanup(() => {
    clear()
  })

  return value
}

function PacedMarkdown(props: { text: string; cacheKey: string; streaming: boolean }) {
  const value = createPacedValue(
    () => props.text,
    () => props.streaming,
  )

  return (
    <Show when={value()}>
      <Markdown text={value()} cacheKey={props.cacheKey} streaming={props.streaming} />
    </Show>
  )
}

function relativizeProjectPath(path: string, directory?: string) {
  if (!path) return ""
  if (!directory) return path
  if (directory === "/") return path
  if (directory === "\\") return path
  if (path === directory) return ""

  const separator = directory.includes("\\") ? "\\" : "/"
  const prefix = directory.endsWith(separator) ? directory : directory + separator
  if (!path.startsWith(prefix)) return path
  return path.slice(directory.length)
}

function getDirectory(path: string | undefined) {
  const data = useData()
  return relativizeProjectPath(_getDirectory(path), data.directory)
}
import { resolveFileDiff } from "./session-diff"

export type ToolInfo = {
  icon: IconProps["name"]
  title: string
  subtitle?: string
  args?: string[]
}

function agentTitle(i18n: TranscriptI18n, type?: string) {
  if (!type) return i18n.t("transcript.tool.agent.default")
  return i18n.t("transcript.tool.agent", { type })
}

function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

export function getToolInfo(
  tool: string,
  input: any = {},
  metadata: Record<string, unknown> | undefined = {},
): ToolInfo {
  const i18n = useTranscriptI18n()
  switch (tool) {
    case "read": {
      const args: string[] = []
      if (input.offset) args.push("offset=" + input.offset)
      if (input.limit) args.push("limit=" + input.limit)
      return {
        icon: "glasses",
        title: i18n.t("transcript.tool.read"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
        args,
      }
    }
    case "list":
      return {
        icon: "bullet-list",
        title: i18n.t("transcript.tool.list"),
        subtitle: getDirectory(input.path || "/"),
      }
    case "glob":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("transcript.tool.glob"),
        subtitle: getDirectory(input.path || "/"),
        args: input.pattern ? ["pattern=" + input.pattern] : [],
      }
    case "grep": {
      const args: string[] = []
      if (input.pattern) args.push("pattern=" + input.pattern)
      if (input.include) args.push("include=" + input.include)
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("transcript.tool.grep"),
        subtitle: getDirectory(input.path || "/"),
        args,
      }
    }
    case "webfetch":
      return {
        icon: "magnifying-glass",
        title: i18n.t("transcript.tool.webfetch"),
        subtitle: input.url,
      }
    case "websearch":
      return {
        icon: "magnifying-glass",
        title: webSearchProviderLabel(metadata?.provider),
        subtitle: input.query,
      }
    case "task": {
      const type =
        typeof input.subagent_type === "string" && input.subagent_type
          ? input.subagent_type[0]!.toUpperCase() + input.subagent_type.slice(1)
          : undefined
      return {
        icon: "task",
        title: agentTitle(i18n, type),
        subtitle: input.description,
      }
    }
    case "bash":
      return {
        icon: "terminal",
        title: i18n.t("transcript.tool.shell"),
        subtitle: input.command,
      }
    case "edit":
      return {
        icon: "pencil-line",
        title: i18n.t("transcript.messagePart.title.edit"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "write":
      return {
        icon: "file",
        title: i18n.t("transcript.messagePart.title.write"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "apply_patch":
      return {
        icon: "pencil-line",
        title: i18n.t("transcript.tool.patch"),
        subtitle: input.files?.length
          ? `${input.files.length} ${i18n.t(input.files.length > 1 ? "transcript.common.file.other" : "transcript.common.file.one")}`
          : undefined,
      }
    case "todowrite":
      return {
        icon: "checklist",
        title: i18n.t("transcript.tool.todos"),
      }
    case "question":
      return {
        icon: "bubble-5",
        title: i18n.t("transcript.tool.questions"),
      }
    case "skill":
      return {
        icon: "brain",
        title: input.name || input.skill || i18n.t("transcript.tool.skill"),
      }
    default:
      return {
        icon: "mcp",
        title: tool,
      }
  }
}

function sessionLink(
  id: string | undefined,
  path: string,
  href?: (id: string) => string | undefined,
): string | undefined {
  if (!id) return undefined

  const direct = href?.(id)
  if (direct) return direct

  const idx = path.indexOf("/session")
  if (idx === -1) return undefined
  return `${path.slice(0, idx)}/session/${id}`
}

function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function index<T extends { id: string }>(items: readonly T[]) {
  return new Map(items.map((item) => [item.id, item] as const))
}

export function renderable(part: AgentContentPart, showReasoningSummaries = true) {
  if (part.type === "tool") {
    if (isHiddenTool(part)) return false
    return !isPendingQuestion(part)
  }
  if (part.type === "text") return !!part.text?.trim()
  if (part.type === "reasoning") return showReasoningSummaries && !!part.text?.trim()
  return !!PART_MAPPING[part.type]
}

export function partDefaultOpen(part: AgentContentPart, shell = false, edit = false): boolean | undefined {
  if (part.type !== "tool") return undefined
  return toolOpensByDefault(part.tool, { shell, edit })
}

type GroupMember = { message: AgentAssistantMessage; part: AgentToolPart }

type PartGroupSlots = {
  showAssistantCopyPartId?: string | null
  turnDurationMs?: number
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
}

function PartGroups(
  props: PartGroupSlots & {
    groups: PartGroup[]
    message: (messageId: string) => AgentAssistantMessage | undefined
    part: (ref: PartRef) => AgentContentPart | undefined
    busyGroupKey?: string
  },
) {
  const emptyTools: AgentToolPart[] = []
  const emptyMembers: GroupMember[] = []

  const tools = (group: PartGroup) => {
    if (group.type === "part") return emptyTools
    return group.refs
      .map((ref) => props.part(ref))
      .filter((part): part is AgentToolPart => part?.type === "tool")
  }

  const members = (group: PartGroup) => {
    if (group.type === "part") return emptyMembers
    return group.refs
      .map((ref) => {
        const message = props.message(ref.messageId)
        const part = props.part(ref)
        if (!message || part?.type !== "tool") return undefined
        return { message, part }
      })
      .filter((member): member is GroupMember => !!member)
  }

  return (
    <Index each={props.groups}>
      {(entryAccessor) => {
        const entryType = createMemo(() => entryAccessor().type)
        const busy = createMemo(() => props.busyGroupKey === entryAccessor().key)

        return (
          <Switch>
            <Match when={entryType() === "context"}>
              {(() => {
                const group = createMemo(() => members(entryAccessor()))
                return (
                  <Show when={group().length > 0}>
                    <ContextToolGroup parts={group().map((member) => member.part)} busy={busy()}>
                      <For each={group()}>
                        {(member) => <Part part={member.part} message={member.message} />}
                      </For>
                    </ContextToolGroup>
                  </Show>
                )
              })()}
            </Match>
            <Match when={entryType() === "agents"}>
              {(() => {
                const parts = createMemo(() => tools(entryAccessor()), emptyTools, { equals: same })
                return <SubagentChipRow parts={parts()} />
              })()}
            </Match>
            <Match when={entryType() === "work"}>
              {(() => {
                const group = createMemo(() => members(entryAccessor()))

                return (
                  <WorkGroup parts={group().map((member) => member.part)} busy={busy()}>
                    <For each={group()}>
                      {(member) => (
                        <Part
                          part={member.part}
                          message={member.message}
                          turnDurationMs={props.turnDurationMs}
                          defaultOpen={partDefaultOpen(
                            member.part,
                            props.shellToolDefaultOpen,
                            props.editToolDefaultOpen,
                          )}
                        />
                      )}
                    </For>
                  </WorkGroup>
                )
              })()}
            </Match>
            <Match when={entryType() === "part"}>
              {(() => {
                const message = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return undefined
                  return props.message(entry.ref.messageId)
                })
                const item = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return undefined
                  return props.part(entry.ref)
                })

                return (
                  <Show when={message()}>
                    {(message) => (
                      <Show when={item()}>
                        {(item) => (
                          <Part
                            part={item()}
                            message={message()}
                            showAssistantCopyPartId={props.showAssistantCopyPartId}
                            turnDurationMs={props.turnDurationMs}
                            defaultOpen={partDefaultOpen(
                              item(),
                              props.shellToolDefaultOpen,
                              props.editToolDefaultOpen,
                            )}
                          />
                        )}
                      </Show>
                    )}
                  </Show>
                )
              })()}
            </Match>
          </Switch>
        )
      }}
    </Index>
  )
}

function contextToolSummary(parts: AgentToolPart[]) {
  const read = parts.filter((part) => part.tool === "read").length
  const search = parts.filter((part) => part.tool === "glob" || part.tool === "grep").length
  const list = parts.filter((part) => part.tool === "list").length
  return { read, search, list }
}

function ExaOutput(props: { output?: string }) {
  const links = createMemo(() => transcriptLinks(props.output))

  return (
    <Show when={links().length > 0}>
      <div class="ui-exa-tool-output">
        <div data-slot="exa-tool-links">
          <For each={links()}>
            {(url) => (
              <a
 class="ui-exa-tool-link"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  event.stopPropagation()
                  handleTranscriptLinkClick(event)
                }}
              >
                {url}
              </a>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

function userMessage(message: AgentPresentationMessage): AgentUserMessage | undefined {
  if (message.role === "user") return message
  return undefined
}

function assistantMessage(message: AgentPresentationMessage): AgentAssistantMessage | undefined {
  if (message.role === "assistant") return message
  return undefined
}

export function Message(props: MessageProps) {
  return (
    <Switch>
      <Match when={userMessage(props.message)}>
        {(message) => (
          <UserMessageDisplay message={message()} parts={props.parts} actions={props.actions} />
        )}
      </Match>
      <Match when={assistantMessage(props.message)}>
        {(message) => (
          <AssistantMessageDisplay
            message={message()}
            parts={props.parts}
            showAssistantCopyPartId={props.showAssistantCopyPartId}
            showReasoningSummaries={props.showReasoningSummaries}
          />
        )}
      </Match>
    </Switch>
  )
}

export function AssistantMessageDisplay(props: {
  message: AgentAssistantMessage
  parts: AgentContentPart[]
  showAssistantCopyPartId?: string | null
  showReasoningSummaries?: boolean
}) {
  const part = createMemo(() => index(props.parts))
  const grouped = createMemo(
    () =>
      groupParts(
        props.parts
          .filter((part) => renderable(part, props.showReasoningSummaries ?? true))
          .map((part) => ({
            messageId: props.message.id,
            part,
          })),
      ),
    [] as PartGroup[],
    { equals: sameGroups },
  )

  return (
    <PartGroups
      groups={grouped()}
      message={() => props.message}
      part={(ref) => part().get(ref.partId)}
      showAssistantCopyPartId={props.showAssistantCopyPartId}
    />
  )
}

export function ContextToolGroup(props: {
  parts: AgentToolPart[]
  busy?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSizeChange?: () => void
  children: JSX.Element
}) {
  const i18n = useTranscriptI18n()
  const [localOpen, setLocalOpen] = createSignal(false)
  const open = () => props.open ?? localOpen()
  const pending = createMemo(
    () =>
      props.parts.some((part) => part.state.status === "pending" || part.state.status === "running"),
  )
  const summary = createMemo(() => contextToolSummary(props.parts))
  const handleOpenChange = (value: boolean) => {
    if (props.open === undefined) setLocalOpen(value)
    props.onOpenChange?.(value)
    props.onSizeChange?.()
  }

  return (
    <Collapsible
      open={open()}
      onOpenChange={handleOpenChange}
      variant="ghost"
      class="tool-collapsible"
      data-timeline-part-ids={props.parts.map((part) => part.id).join(",")}
    >
      <Collapsible.Trigger>
        <div data-component="context-tool-group-trigger">
          <span
            data-slot="context-tool-group-title"
            class="min-w-0 flex items-center gap-2 text-14-medium text-text-strong"
          >
            <span class="shrink-0">
              <ToolStatusTitle
                active={pending()}
                activeText={i18n.t("transcript.sessionTurn.status.gatheringContext")}
                doneText={i18n.t("transcript.sessionTurn.status.gatheredContext")}
                split={false}
              />
            </span>
            <span
              class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-text-base"
            >
              <AnimatedCountList
                items={[
                  {
                    key: "read",
                    count: summary().read,
                    one: i18n.t("transcript.messagePart.context.read.one"),
                    other: i18n.t("transcript.messagePart.context.read.other"),
                  },
                  {
                    key: "search",
                    count: summary().search,
                    one: i18n.t("transcript.messagePart.context.search.one"),
                    other: i18n.t("transcript.messagePart.context.search.other"),
                  },
                  {
                    key: "list",
                    count: summary().list,
                    one: i18n.t("transcript.messagePart.context.list.one"),
                    other: i18n.t("transcript.messagePart.context.list.other"),
                  },
                ]}
                fallback=""
              />
            </span>
          </span>
          <Collapsible.Arrow />
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div data-component="context-tool-group-list">{props.children}</div>
      </Collapsible.Content>
    </Collapsible>
  )
}

export function WorkGroup(props: {
  parts: AgentToolPart[]
  busy?: boolean
  memberOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSizeChange?: () => void
  children: JSX.Element
}) {
  const i18n = useTranscriptI18n()
  const [localOpen, setLocalOpen] = createSignal(false)
  const [overflowing, setOverflowing] = createSignal(false)
  const open = () => props.open ?? localOpen()
  const pending = createMemo(
    () =>
      !!props.busy || props.parts.some((part) => part.state.status === "pending" || part.state.status === "running"),
  )
  const summary = createMemo(() => workGroupSummary(props.parts))
  const icon = createMemo(() => workGroupIcon(props.parts))
  const title = createMemo(
    () => workGroupActiveLabel(props.parts, i18n, props.busy) ?? workGroupTitle(summary(), pending(), i18n),
  )
  const handleOpenChange = (value: boolean) => {
    if (props.open === undefined) setLocalOpen(value)
    props.onOpenChange?.(value)
    props.onSizeChange?.()
  }

  let listRef: HTMLDivElement | undefined
  onMount(() => {
    if (!listRef || typeof ResizeObserver === "undefined") return
    const measure = () => setOverflowing(!!listRef && listRef.scrollHeight - listRef.clientHeight > 1)
    const observer = new ResizeObserver(measure)
    observer.observe(listRef)
    measure()
    onCleanup(() => observer.disconnect())
  })

  return (
    <Collapsible
      open={open()}
      onOpenChange={handleOpenChange}
      variant="ghost"
      class="tool-collapsible"
      data-timeline-part-ids={props.parts.map((part) => part.id).join(",")}
    >
      <Collapsible.Trigger>
        <div data-component="work-group-trigger">
          <span data-slot="work-group-icon">
            <Icon name={icon()} size="small" />
          </span>
          <span class="ui-work-group-summary">
            <TextShimmer text={title()} active={pending()} />
          </span>
          <Collapsible.Arrow />
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div
          ref={listRef}
 class="ui-work-group-list"
          data-scrollable
          data-overflowing={overflowing() && !props.memberOpen ? "true" : undefined}
          data-member-open={props.memberOpen ? "true" : undefined}
        >
          {props.children}
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}

export function UserMessageDisplay(props: {
  message: AgentUserMessage
  parts: AgentContentPart[]
  actions?: UserActions
}) {
  const i18n = useTranscriptI18n()
  const [state, setState] = createStore({
    copied: false,
    busy: false,
  })
  const copied = () => state.copied
  const busy = () => state.busy

  const textPart = createMemo(() =>
    props.parts?.find((part): part is AgentTextPart => part.type === "text" && !part.synthetic),
  )

  const text = createMemo(() => textPart()?.text || "")

  const files = createMemo(() => props.parts?.filter((part) => part.type === "file") ?? [])

  const attachments = createMemo(() => files().filter(attached))

  const inlineFiles = createMemo(() => files().filter(inline))

  const agents = createMemo(() => props.parts?.filter((part) => part.type === "agent") ?? [])

  const shape = createMemo((): "markdown" | "text" | "empty" => {
    if (!text()) return "empty"
    return shouldRenderUserMarkdown(text()) && inlineFiles().length === 0 && agents().length === 0 ? "markdown" : "text"
  })

  const model = createMemo(() => {
    const providerId = props.message.model?.providerID
    const modelId = props.message.model?.modelID
    if (!providerId || !modelId) return ""
    return modelId
  })
  const timefmt = createMemo(() => new Intl.DateTimeFormat(i18n.intlTag(), { timeStyle: "short" }))

  const stamp = createMemo(() => {
    const created = props.message.time?.created
    if (typeof created !== "number") return ""
    return timefmt().format(created)
  })

  const metaHead = createMemo(() => {
    const agent = props.message.agent
    const items = [agent ? agent[0]?.toUpperCase() + agent.slice(1) : "", model()]
    return items.filter((x) => !!x).join("\u00A0\u00B7\u00A0")
  })

  const metaTail = stamp

  const openImagePreview = useImagePreview()

  const handleCopy = async () => {
    const content = text()
    if (!content) return
    if ((await copyText(content)).copied) {
      setState("copied", true)
      setTimeout(() => setState("copied", false), 2000)
    }
  }

  const revert = () => {
    const act = props.actions?.revert
    if (!act || busy()) return
    setState("busy", true)
    void Promise.resolve()
      .then(() =>
        act({
          sessionId: props.message.sessionID,
          messageId: props.message.id,
        }),
      )
      .finally(() => setState("busy", false))
  }

  const metaHeadSpan = () => (
    <span data-slot="user-message-meta" class="text-12-regular text-text-weak cursor-default">
      {metaHead()}
    </span>
  )
  const metaTailSpan = () => (
    <span data-slot="user-message-meta-tail" class="text-12-regular text-text-weak cursor-default">
      {metaTail()}
    </span>
  )

  const footer = () => (
    <div class="ui-user-message-copy-wrapper">
      <Switch>
        <Match when={metaHead() && metaTail()}>
          <span data-slot="user-message-meta-wrap">
            {metaHeadSpan()}
            <span class="text-12-regular text-text-weak cursor-default">{"\u00A0\u00B7\u00A0"}</span>
            {metaTailSpan()}
          </span>
        </Match>
        <Match when={metaHead()}>
          <span data-slot="user-message-meta-wrap">{metaHeadSpan()}</span>
        </Match>
        <Match when={metaTail()}>
          <span data-slot="user-message-meta-wrap">{metaTailSpan()}</span>
        </Match>
      </Switch>
      <Show when={props.actions?.revert}>
        <MessageActionButton
          icon="reset"
          label={i18n.t("transcript.message.revertMessage")}
          disabled={busy()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            revert()
          }}
          aria-label={i18n.t("transcript.message.revertMessage")}
        />
      </Show>
      <MessageActionButton
        icon={copied() ? "check" : "copy"}
        label={copied() ? i18n.t("transcript.message.copied") : i18n.t("transcript.message.copyMessage")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation()
          void handleCopy()
        }}
        aria-label={copied() ? i18n.t("transcript.message.copied") : i18n.t("transcript.message.copyMessage")}
      />
    </div>
  )

  return (
    <div data-component="user-message" class="ui-user-message" data-timeline-part-id={textPart()?.id}>
      <Show when={attachments().length > 0}>
        <div data-slot="user-message-attachments" class="ui-user-message-attachments">
          <For each={attachments()}>
            {(file) => {
              const type = kind(file)
              const name = file.filename ?? i18n.t("transcript.message.attachment.alt")
              return (
                <div
                  class="ui-user-message-attachment"
                  data-type={type}
                  data-clickable={type === "image" ? "true" : undefined}
                  title={type === "file" ? name : undefined}
                  onClick={() => {
                    if (type === "image") openImagePreview(file.url, name)
                  }}
                >
                  {type === "image" ? (
                    <img data-slot="user-message-attachment-image" src={file.url} alt={name} />
                  ) : (
                    <div data-slot="user-message-attachment-file">
                      <FileIcon node={{ path: name, type: "file" }} />
                      <span class="ui-user-message-attachment-name">{name}</span>
                    </div>
                  )}
                </div>
              )
            }}
          </For>
        </div>
      </Show>
      <Switch>
        <Match when={shape() === "markdown"}>
          <div class="ui-user-message-body" data-markdown="true">
            <div data-slot="user-message-text" class="ui-user-message-text" data-markdown="true">
              <Markdown text={text()} cacheKey={textPart()?.id} streaming={false} />
            </div>
          </div>
          {footer()}
        </Match>
        <Match when={shape() === "text"}>
          <div class="ui-user-message-body">
            <div data-slot="user-message-text" class="ui-user-message-text">
              <HighlightedText text={text()} references={inlineFiles()} agents={agents()} />
            </div>
          </div>
          {footer()}
        </Match>
      </Switch>
    </div>
  )
}

type HighlightSegment = { text: string; type?: "file" | "agent" }

function HighlightedText(props: { text: string; references: AgentFilePart[]; agents: AgentAgentPart[] }) {
  const segments = createMemo(() => {
    const text = props.text

    const allRefs: { start: number; end: number; type: "file" | "agent" }[] = [
      ...props.references
        .filter((r) => r.source?.text?.start !== undefined && r.source?.text?.end !== undefined)
        .map((r) => ({ start: r.source!.text.start, end: r.source!.text.end, type: "file" as const })),
      ...props.agents
        .filter((a) => a.source?.start !== undefined && a.source?.end !== undefined)
        .map((a) => ({ start: a.source!.start, end: a.source!.end, type: "agent" as const })),
    ].sort((a, b) => a.start - b.start)

    const result: HighlightSegment[] = []
    let lastIndex = 0

    for (const ref of allRefs) {
      if (ref.start < lastIndex) continue

      if (ref.start > lastIndex) {
        result.push({ text: text.slice(lastIndex, ref.start) })
      }

      result.push({ text: text.slice(ref.start, ref.end), type: ref.type })
      lastIndex = ref.end
    }

    if (lastIndex < text.length) {
      result.push({ text: text.slice(lastIndex) })
    }

    return result
  })

  return <For each={segments()}>{(segment) => <span data-highlight={segment.type}>{segment.text}</span>}</For>
}

export function Part(props: MessagePartProps) {
  const component = createMemo(() => (isRetractedPart(props.part) ? RetractedPartDisplay : PART_MAPPING[props.part.type]))
  return (
    <Show when={component()}>
      <Dynamic
        component={component()}
        part={props.part}
        message={props.message}
        hideDetails={props.hideDetails}
        defaultOpen={props.defaultOpen}
        toolOpen={props.toolOpen}
        onToolOpenChange={props.onToolOpenChange}
        toolRevealed={props.toolRevealed}
        onToolRevealedChange={props.onToolRevealedChange}
        deferToolContent={props.deferToolContent}
        virtualizeDiff={props.virtualizeDiff}
        onContentRendered={props.onContentRendered}
        showAssistantCopyPartId={props.showAssistantCopyPartId}
        turnDurationMs={props.turnDurationMs}
        turnInterrupted={props.turnInterrupted}
      />
    </Show>
  )
}

export interface ToolProps {
  input: Record<string, any>
  metadata: Record<string, any>
  tool: string
  toolCallId?: string
  sessionId?: string
  output?: string
  status?: string
  startedAt?: number
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  revealed?: boolean
  onRevealedChange?: (revealed: boolean) => void
  deferContent?: boolean
  virtualizeDiff?: boolean
  onContentRendered?: () => void
  forceOpen?: boolean
  locked?: boolean
  bodyPending?: boolean
}

export type ToolComponent = Component<ToolProps>

const state: Record<
  string,
  {
    name: string
    render?: ToolComponent
  }
> = {}

export function registerTool(input: { name: string; render?: ToolComponent }) {
  state[input.name] = input
  return input
}

export function getTool(name: string) {
  return state[name.toLowerCase()]?.render
}

export const ToolRegistry = {
  register: registerTool,
  render: getTool,
}

function ToolFileAccordion(props: { path: string; actions?: JSX.Element; children: JSX.Element }) {
  const value = createMemo(() => props.path || "tool-file")

  return (
    <Accordion
      multiple
      data-scope="apply-patch"
      style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}
      defaultValue={[value()]}
    >
      <Accordion.Item value={value()}>
        <StickyAccordionHeader>
          <Accordion.Trigger>
            <div data-slot="apply-patch-trigger-content">
              <div data-slot="apply-patch-file-info">
                <FileIcon node={{ path: props.path, type: "file" }} />
                <div data-slot="apply-patch-file-name-container">
                  <Show when={props.path.includes("/")}>
                    <span data-slot="apply-patch-directory">{`\u202A${getDirectory(props.path)}\u202C`}</span>
                  </Show>
                  <span data-slot="apply-patch-filename">{getFilename(props.path)}</span>
                </div>
              </div>
              <div data-slot="apply-patch-trigger-actions">
                {props.actions}
              </div>
            </div>
          </Accordion.Trigger>
        </StickyAccordionHeader>
        <Accordion.Content>{props.children}</Accordion.Content>
      </Accordion.Item>
    </Accordion>
  )
}

function FrameDeferred(props: { content: () => JSX.Element }) {
  const [ready, setReady] = createSignal(false)
  let frame: number | undefined
  onMount(() => {
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = undefined
        setReady(true)
      })
    })
  })
  onCleanup(() => frame !== undefined && cancelAnimationFrame(frame))
  return <Show when={ready()}>{props.content()}</Show>
}

PART_MAPPING["tool"] = function ToolPartDisplay(props) {
  const data = useData()
  const i18n = useTranscriptI18n()
  const part = () => {
    const value = props.part
    if (value.type !== "tool") throw wrongPartType("tool", value)
    return value
  }
  if (part().tool === "todowrite") return null

  const hideQuestion = createMemo(
    () => part().tool === "question" && (part().state.status === "pending" || part().state.status === "running"),
  )

  const boundSubagents = createMemo(() => isSubagentToolPart(part())
    ? data.resolveSubagents?.(part().sessionID, part().callID) ?? []
    : [])

  const toolError = createMemo(() => {
    const state = part().state
    return state.status === "error" ? state.error : undefined
  })

  const toolStartedAt = createMemo(() => {
    const state = part().state
    return state.status === "pending" ? undefined : state.time.start
  })

  const emptyInput: Record<string, unknown> = {}
  const emptyMetadata: Record<string, unknown> = {}

  const input = () => part().state.input ?? emptyInput
  const partMetadata = () => {
    const state = part().state
    if (state.status === "pending") return emptyMetadata
    return state.metadata ?? emptyMetadata
  }
  const toolOutput = createMemo(() => {
    const state = part().state
    return state.status === "completed" ? state.output : undefined
  })
  const toolAttachments = createMemo(() => {
    const state = part().state
    return state.status === "completed" ? state.attachments : undefined
  })
  const taskId = createMemo(() => {
    if (part().tool !== "task") return undefined
    const value = partMetadata().sessionId
    if (typeof value === "string" && value) return value
    return undefined
  })
  const taskHref = createMemo(() => {
    if (part().tool !== "task") return undefined
    return sessionLink(taskId(), useLocation().pathname, data.sessionHref)
  })
  const taskSubtitle = createMemo(() => {
    if (part().tool !== "task") return undefined
    const value = input().description
    if (typeof value === "string" && value) return value
    return taskId()
  })

  const claxedo = createMemo(() => claxedoToolName(part().tool, input()))
  const claxedoSubject = createMemo(() => {
    const name = claxedo()
    if (!name) return undefined
    const view = claxedoToolView({ name, input: input(), output: undefined, i18n })
    if (view.link) {
      const href = view.link.kind === "task" ? data.taskHref?.(view.link.id) : data.sessionHref?.(view.link.id)
      return { subtitle: view.link.label, href }
    }
    return { subtitle: view.subject ?? view.title, href: data.claxedoToolHref?.(name, input()) }
  })

  const render = createMemo(() => claxedo() ? ClaxedoTool : ToolRegistry.render(part().tool) ?? GenericTool)
  const controlledOpen = () => (props.onToolOpenChange ? (props.toolOpen ?? props.defaultOpen) : undefined)
  const [opened, setOpened] = createSignal(props.defaultOpen ?? false)
  const bodyPending = () => part().headerOnly === true
  createEffect(() => {
    if (bodyPending() && (controlledOpen() ?? opened())) data.loadToolBody?.(part())
  })
  const handleToolOpenChange = (open: boolean) => {
    setOpened(open)
    props.onToolOpenChange?.(open)
  }

  return (
    <Show when={!hideQuestion()}>
      <div data-component="tool-part-wrapper" data-timeline-part-id={part().id}>
        <Switch>
          <Match when={!claxedo() && boundSubagents().length > 0}>
            <SubagentChipRow subagents={boundSubagents()} spawnInput={input()} />
          </Match>
          <Match when={toolError()}>
            {(error) => {
              if (part().tool === "question" && isQuestionDeclined(partMetadata())) {
                return (
                  <div style="width: 100%; display: flex; justify-content: flex-end;">
                    <span class="text-13-regular text-text-weak cursor-default">
                      {i18n.t("transcript.messagePart.questions.dismissed")}
                    </span>
                  </div>
                )
              }
              return (
                <ToolErrorCard
                  icon={claxedo() ? "claxedo" : undefined}
                  tool={part().tool}
                  error={error()}
                  title={
                    claxedo()
                      ? claxedoToolTitle(claxedo()!, i18n)
                      : part().tool === "websearch"
                        ? webSearchProviderLabel(partMetadata().provider)
                        : undefined
                  }
                  defaultOpen={props.defaultOpen}
                  open={controlledOpen()}
                  onOpenChange={handleToolOpenChange}
                  subtitle={taskSubtitle() ?? claxedoSubject()?.subtitle}
                  href={taskHref() ?? claxedoSubject()?.href}
                  exitCode={shellExitCode(partMetadata())}
                />
              )
            }}
          </Match>
          <Match when={true}>
            <Dynamic
              component={render()}
              input={input()}
              tool={part().tool}
              toolCallId={part().callID}
              sessionId={part().sessionID}
              metadata={partMetadata()}
              output={toolOutput()}
              status={part().state.status}
              startedAt={toolStartedAt()}
              hideDetails={props.hideDetails}
              defaultOpen={props.defaultOpen}
              open={controlledOpen()}
              onOpenChange={handleToolOpenChange}
              bodyPending={bodyPending()}
              deferContent={props.deferToolContent}
              virtualizeDiff={props.virtualizeDiff}
              onContentRendered={props.onContentRendered}
              revealed={props.onToolRevealedChange ? props.toolRevealed : undefined}
              onRevealedChange={props.onToolRevealedChange}
            />
            <ToolAttachments attachments={toolAttachments()} />
          </Match>
        </Switch>
      </div>
    </Show>
  )
}

PART_MAPPING["compaction"] = function CompactionPartDisplay() {
  const i18n = useTranscriptI18n()
  return <MessageDivider label={i18n.t("transcript.messagePart.compaction")} icon="archive" />
}

PART_MAPPING["notice"] = NoticePartDisplay

PART_MAPPING["text"] = function TextPartDisplay(props) {
  const i18n = useTranscriptI18n()
  const numfmt = createMemo(() => new Intl.NumberFormat(i18n.intlTag()))
  const part = () => {
    const value = props.part
    if (value.type !== "text") throw wrongPartType("text", value)
    return value
  }
  const interrupted = createMemo(
    () =>
      props.message.role === "assistant" &&
      (props.turnInterrupted === true || props.message.error?.name === "MessageAbortedError"),
  )

  const model = createMemo(() => {
    if (props.message.role !== "assistant") return ""
    const message = props.message
    return message.modelID ?? ""
  })

  const duration = createMemo(() => {
    if (props.message.role !== "assistant") return ""
    const message = props.message
    const completed = message.time.completed
    const ms =
      typeof props.turnDurationMs === "number"
        ? props.turnDurationMs
        : typeof completed === "number"
          ? completed - message.time.created
          : -1
    if (!(ms >= 0)) return ""
    const total = Math.round(ms / 1000)
    if (total < 60) return i18n.t("transcript.message.duration.seconds", { count: numfmt().format(total) })
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return i18n.t("transcript.message.duration.minutesSeconds", {
      minutes: numfmt().format(minutes),
      seconds: numfmt().format(seconds),
    })
  })

  const meta = createMemo(() => {
    if (props.message.role !== "assistant") return ""
    const agent = props.message.agent
    const items = [
      agent ? agent[0]?.toUpperCase() + agent.slice(1) : "",
      model(),
      duration(),
      interrupted() ? i18n.t("transcript.message.interrupted") : "",
    ]
    return items.filter((x) => !!x).join(" \u00B7 ")
  })

  const streaming = createMemo(
    () =>
      props.message.role === "assistant" &&
      typeof props.message.time.completed !== "number" &&
      typeof part().time?.end !== "number" &&
      props.turnInterrupted !== true,
  )
  const text = () => readPartText(part())
  const showCopy = createMemo(() => props.message.role === "assistant" && props.showAssistantCopyPartId === part().id)
  const [copied, setCopied] = createSignal(false)

  const handleCopy = async () => {
    const content = text()
    if (!content) return
    if ((await copyText(content)).copied) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <Show when={text()}>
      <div data-component="text-part" class="ui-text-part" data-timeline-part-id={part().id}>
        <div data-slot="text-part-body">
          <PacedMarkdown text={text()} cacheKey={part().id} streaming={streaming()} />
        </div>
        <Show when={showCopy()}>
          <div class="ui-text-part-copy-wrapper" data-interrupted={interrupted() ? "" : undefined}>
            <MessageActionButton
              icon={copied() ? "check" : "copy"}
              label={copied() ? i18n.t("transcript.message.copied") : i18n.t("transcript.message.copyResponse")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleCopy}
              aria-label={copied() ? i18n.t("transcript.message.copied") : i18n.t("transcript.message.copyResponse")}
            />
            <Show when={meta()}>
              <span data-slot="text-part-meta" class="text-12-regular text-text-weak cursor-default">
                {meta()}
              </span>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}

PART_MAPPING["reasoning"] = function ReasoningPartDisplay(props) {
  const part = () => {
    const value = props.part
    if (value.type !== "reasoning") throw wrongPartType("reasoning", value)
    return value
  }
  const streaming = createMemo(
    () =>
      typeof part().time?.end !== "number" &&
      props.message.role === "assistant" &&
      typeof props.message.time.completed !== "number" &&
      props.turnInterrupted !== true,
  )
  const [chosenOpen, setChosenOpen] = createSignal<boolean>()
  const text = () => readPartText(part())
  const durationMs = createMemo(() => {
    const time = part().time
    if (time?.start && time?.end) return Math.max(0, time.end - time.start)
    return undefined
  })
  const title = createMemo(() => {
    if (streaming()) return "Thinking…"
    const ms = durationMs()
    return typeof ms === "number" ? `Thought for ${formatDuration(ms)}` : "Thought"
  })

  return (
    <Show when={text()}>
      <div data-component="reasoning-part" class="ui-reasoning-part" data-timeline-part-id={part().id} data-streaming={streaming() ? "true" : undefined}>
        <BasicTool
          icon="brain"
          status={streaming() ? "running" : undefined}
          startedAt={part().time?.start}
          open={chosenOpen() ?? streaming()}
          onOpenChange={setChosenOpen}
          trigger={{ title: title() }}
        >
          <div data-component="reasoning-content">
            <PacedMarkdown text={text()} cacheKey={part().id} streaming={streaming()} />
          </div>
        </BasicTool>
      </div>
    </Show>
  )
}

function useImagePreview() {
  const dialog = useDialog()
  return (url: string, alt?: string) => void dialog.show(() => <ImagePreview src={url} alt={alt} />)
}

function ToolImageStrip(props: { images: AgentFilePart[] }) {
  const data = useData()
  const openImagePreview = useImagePreview()
  return (
    <For each={props.images}>
      {(image) => {
        const name = () => image.filename ?? getFilename(image.url) ?? image.url
        const [loaded, setLoaded] = createSignal<string>()
        const [loadFailed, setLoadFailed] = createSignal(false)
        const [attempt, setAttempt] = createSignal(0)
        const retry = () => setAttempt((value) => value + 1)
        createEffect(() => {
          attempt()
          if (image.location?.kind !== "tool-file" || !data.readToolImage) return
          const controller = new AbortController()
          let objectUrl: string | undefined
          setLoaded(undefined)
          setLoadFailed(false)
          void data.readToolImage(image, controller.signal).then((blob) => {
            if (controller.signal.aborted) return
            objectUrl = URL.createObjectURL(blob)
            setLoaded(objectUrl)
          }).catch((error: unknown) => {
            if (controller.signal.aborted) return
            console.warn("A tool image could not be read", { error })
            setLoadFailed(true)
          })
          onCleanup(() => {
            controller.abort()
            if (objectUrl) URL.revokeObjectURL(objectUrl)
          })
        })
        const src = createMemo(() => {
          const location = image.location
          if (!location) return image.url
          if (location.kind === "unretained") return undefined
          if (location.kind === "tool-file") return loaded()
          return data.fileUrl?.(location.path)
        })
        return (
          <div class="ui-tool-image">
            <Show when={src()} fallback={<ToolImageUnavailable name={name()} location={image.location} onRetry={loadFailed() ? retry : undefined} />}>
              {(url) => {
                const [failed, setFailed] = createSignal(false)
                return (
                  <Show when={!failed()} fallback={<ToolImageUnavailable name={name()} location={image.location} />}>
                    <button
                      type="button"
                      data-slot="tool-image-open"
                      aria-label={name()}
                      onClick={() => openImagePreview(url(), name())}
                    >
                      <img
                        data-slot="tool-image-thumbnail"
                        src={url()}
                        alt={name()}
                        onError={() => setFailed(true)}
                      />
                    </button>
                  </Show>
                )
              }}
            </Show>
          </div>
        )
      }}
    </For>
  )
}

export function ToolAttachments(props: { attachments?: AgentFilePart[] }) {
  const images = createMemo(() => (props.attachments ?? []).filter((file) => file.mime.startsWith("image/")))
  return (
    <Show when={images().length > 0}>
      <ToolImageStrip images={images()} />
    </Show>
  )
}

function ToolImageUnavailable(props: { name: string; location?: AgentFileLocation; onRetry?: () => void }) {
  const i18n = useTranscriptI18n()
  const [expanded, setExpanded] = createSignal(false)
  const unretained = () => (props.location?.kind === "unretained" ? props.location : undefined)
  const label = () => (
    <>
      <Icon name="photo" size="small" />
      <span>{props.name}</span>
    </>
  )
  return (
    <div class="ui-tool-image-unavailable">
      <Show
        when={unretained()}
        fallback={
          <div data-slot="tool-image-unavailable-row">
            {label()}
            <Show when={props.onRetry}>
              <button type="button" onClick={props.onRetry}>{i18n.t("transcript.message.queued.retry")}</button>
            </Show>
          </div>
        }
      >
        {(location) => {
          const size = () => `${Math.round(location().bytes / 1024)} KB`
          return (
            <>
              <button
                type="button"
                data-slot="tool-image-unavailable-row"
                aria-expanded={expanded()}
                onClick={() => setExpanded((value) => !value)}
              >
                {label()}
                <span data-slot="tool-image-size">{size()}</span>
                <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
              </button>
              <Show when={expanded()}>
                <div data-slot="tool-image-unavailable-note">
                  <Icon name="photo" size="large" />
                  <span>{i18n.t("transcript.tool.image.tooLarge", { size: size() })}</span>
                </div>
              </Show>
            </>
          )
        }}
      </Show>
    </div>
  )
}

PART_MAPPING["file"] = function FilePartDisplay(props) {
  const openImagePreview = useImagePreview()
  const part = () => {
    const value = props.part
    if (value.type !== "file") throw wrongPartType("file", value)
    return value
  }
  const name = createMemo(() => part().filename ?? getFilename(part().url) ?? part().url)
  const isImage = createMemo(() => part().mime.startsWith("image/"))
  const isAudio = createMemo(() => part().mime.startsWith("audio/"))
  const href = createMemo(() => transcriptLinkHref(part().url))

  return (
    <div data-timeline-part-id={part().id}>
      <Switch
        fallback={
          <Show
            when={href()}
            fallback={
              <span data-slot="file-part-link">
                <FileIcon node={{ path: name(), type: "file" }} />
                <span>{name()}</span>
              </span>
            }
          >
            {(safe) => (
              <a
                data-slot="file-part-link"
                href={safe()}
                target="_blank"
                rel="noopener noreferrer"
                title={name()}
                onClick={handleTranscriptLinkClick}
              >
                <FileIcon node={{ path: name(), type: "file" }} />
                <span>{name()}</span>
              </a>
            )}
          </Show>
        }
      >
        <Match when={isImage()}>
          <img
            data-slot="file-part-image"
            src={part().url}
            alt={name()}
            onClick={() => openImagePreview(part().url, name())}
          />
        </Match>
        <Match when={isAudio()}>
          <audio controls src={part().url} aria-label={name()} />
        </Match>
      </Switch>
    </div>
  )
}

ToolRegistry.register({
  name: "read",
  render(props) {
    const data = useData()
    const i18n = useTranscriptI18n()
    const info = createMemo(() => getToolInfo("read", props.input))
    const loaded = createMemo(() => {
      if (props.status !== "completed") return []
      const value = props.metadata.loaded
      if (!value || !Array.isArray(value)) return []
      return value.filter((p): p is string => typeof p === "string")
    })
    return (
      <>
        <BasicTool
          {...props}
          icon={info().icon}
          trigger={{ title: info().title, subtitle: info().subtitle ?? "", args: info().args }}
        />
        <For each={loaded()}>
          {(filepath) => (
            <div class="ui-tool-loaded-file">
              <Icon name="enter" size="small" />
              <span>
                {i18n.t("transcript.tool.loaded")} {relativizeProjectPath(filepath, data.directory)}
              </span>
            </div>
          )}
        </For>
      </>
    )
  },
})

ToolRegistry.register({
  name: "list",
  render(props) {
    const info = createMemo(() => getToolInfo("list", props.input))
    return (
      <BasicTool {...props} icon={info().icon} trigger={{ title: info().title, subtitle: info().subtitle }}>
        <Show when={props.output}>
          <ScrollableOutput component="tool-output" revealed={props.revealed} onRevealedChange={props.onRevealedChange}>
            <Markdown text={props.output!} />
          </ScrollableOutput>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "glob",
  render(props) {
    const info = createMemo(() => getToolInfo("glob", props.input))
    return (
      <BasicTool
        {...props}
        icon={info().icon}
        trigger={{ title: info().title, subtitle: info().subtitle, args: info().args }}
      >
        <Show when={props.output}>
          <ScrollableOutput component="tool-output" revealed={props.revealed} onRevealedChange={props.onRevealedChange}>
            <Markdown text={props.output!} />
          </ScrollableOutput>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "grep",
  render(props) {
    const info = createMemo(() => getToolInfo("grep", props.input))
    return (
      <BasicTool
        {...props}
        icon={info().icon}
        trigger={{ title: info().title, subtitle: info().subtitle, args: info().args }}
      >
        <Show when={props.output}>
          <ScrollableOutput component="tool-output" revealed={props.revealed} onRevealedChange={props.onRevealedChange}>
            <Markdown text={props.output!} />
          </ScrollableOutput>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "webfetch",
  render(props) {
    const i18n = useTranscriptI18n()
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const url = createMemo(() => {
      const value = props.input.url
      if (typeof value !== "string") return ""
      return value
    })
    const href = createMemo(() => transcriptLinkHref(url()))
    return (
      <BasicTool
        {...props}
        hideDetails
        icon="magnifying-glass"
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("transcript.tool.webfetch")} active={pending()} />
              </span>
              <Show when={!pending() && url()}>
                <Show
                  when={href()}
                  fallback={
                    <span data-slot="basic-tool-tool-subtitle">{url()}</span>
                  }
                >
                  {(safe) => (
                    <a
                      data-slot="basic-tool-tool-subtitle"
                      class="clickable subagent-link"
                      href={safe()}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(event) => {
                        event.stopPropagation()
                        handleTranscriptLinkClick(event)
                      }}
                    >
                      {url()}
                    </a>
                  )}
                </Show>
              </Show>
            </div>
            <Show when={!pending() && href()}>
              <div data-component="tool-action">
                <Icon name="open-external" size="small" />
              </div>
            </Show>
          </div>
        }
      />
    )
  },
})

ToolRegistry.register({
  name: "websearch",
  render(props) {
    const query = createMemo(() => {
      const value = props.input.query
      if (typeof value !== "string") return ""
      return value
    })
    const title = createMemo(() => webSearchProviderLabel(props.metadata.provider))

    return (
      <BasicTool
        {...props}
        icon="magnifying-glass"
        trigger={{
          title: title(),
          subtitle: query(),
          subtitleClass: "exa-tool-query",
        }}
      >
        <ExaOutput output={props.output} />
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "task",
  render(props) {
    const data = useData()
    const subagents = createMemo(() =>
      props.sessionId ? data.resolveSubagents?.(props.sessionId, props.toolCallId) ?? [] : []
    )
    return <SubagentChipRow subagents={subagents()} spawnInput={props.input} />
  },
})

ToolRegistry.register({
  name: "bash",
  render(props) {
    const i18n = useTranscriptI18n()
    const pending = () => props.status === "pending" || props.status === "running"
    const sawPending = pending()
    const displayCommand = createMemo(() =>
      stripShellWrapper(String(props.input.command ?? props.metadata.command ?? "")),
    )
    const text = createMemo(() => {
      const cmd = displayCommand()
      const out = stripAnsi(props.output || props.metadata.output || "").replace(/\r\n?/g, "\n")
      return `$ ${cmd}${out ? "\n\n" + out : ""}`
    })
    const [copied, setCopied] = createSignal(false)

    const localUrl = createMemo(() => {
      if (pending()) return undefined
      return localPreviewUrl(stripAnsi(props.output || props.metadata.output || ""))
    })
    const localLabel = () => localUrl()?.replace(/^https?:\/\//, "").replace(/\/$/, "")

    const handleCopy = async () => {
      const content = text()
      if (!content) return
      if ((await copyText(content)).copied) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    }

    return (
      <>
      <BasicTool
        {...props}
        icon="terminal"
        trigger={(open) => (
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={pending() ? "Running" : "Ran"} active={pending()} />
              </span>
              <Show when={displayCommand()}>
                <ShellSubmessage text={displayCommand()} animate={sawPending && !open()} />
              </Show>
              <ToolExitCode code={pending() ? undefined : shellExitCode(props.metadata)} />
            </div>
          </div>
        )}
      >
        <div class="ui-bash-output">
          <div class="ui-bash-copy">
            <Tooltip value={copied() ? i18n.t("transcript.message.copied") : i18n.t("transcript.message.copy")} placement="top">
              <IconButton
                icon={<Icon name={copied() ? "check" : "copy"} size="small" />}
                size="normal"
                variant="ghost-muted"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCopy}
                aria-label={copied() ? i18n.t("transcript.message.copied") : i18n.t("transcript.message.copy")}
              />
            </Tooltip>
          </div>
          <ScrollableOutput class="ui-bash-scroll" revealed={props.revealed} onRevealedChange={props.onRevealedChange}>
            <pre data-slot="bash-pre">
              <code>{text()}</code>
            </pre>
          </ScrollableOutput>
        </div>
      </BasicTool>
      <Show when={localUrl()}>
        <a
          data-component="local-preview-row"
          href={localUrl()}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleTranscriptLinkClick}
        >
          <span data-slot="local-preview-icon">
            <Icon name="window-cursor" size="small" />
          </span>
          <span class="ui-local-preview-verb">Local preview</span>
          <span class="ui-local-preview-url">{localLabel()}</span>
        </a>
      </Show>
      </>
    )
  },
})

ToolRegistry.register({
  name: "edit",
  render(props) {
    const i18n = useTranscriptI18n()
    const fileComponent = useFileComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const path = createMemo(() => props.metadata?.filediff?.file || props.input.filePath || "")
    const filename = () => getFilename(props.input.filePath ?? "")
    const pending = () => props.status === "pending" || props.status === "running"
    const diffSource = createMemo(
      () => {
        const filediff = props.metadata?.filediff
        if (!filediff) return undefined
        return {
          file: filediff.file || props.input.filePath || "",
          patch: typeof filediff.patch === "string" ? filediff.patch : undefined,
          before: typeof filediff.before === "string" ? filediff.before : undefined,
          after: typeof filediff.after === "string" ? filediff.after : undefined,
        }
      },
      undefined,
      {
        equals: (a, b) =>
          a?.file === b?.file && a?.patch === b?.patch && a?.before === b?.before && a?.after === b?.after,
      },
    )

    const fileCompProps = createMemo(() => {
      try {
        const source = diffSource()
        if (source) {
          const fileDiff = resolveFileDiff(source)
          if (fileDiff) return { fileDiff, hunkSeparators: fileDiff.isPartial ? "simple" : "line-info-basic" }
        }
      } catch (error) {
        console.warn("An edit's diff could not be resolved; its before and after show instead", { error })
      }

      return {
        before: {
          name: props.metadata?.filediff?.file || props.input.filePath,
          contents: props.metadata?.filediff?.before || props.input.oldString || "",
        },
        after: {
          name: props.metadata?.filediff?.file || props.input.filePath,
          contents: props.metadata?.filediff?.after || props.input.newString || "",
        },
      }
    })

    return (
      <div data-component="edit-tool">
        <BasicTool
          {...props}
          icon="pencil-line"
          defer
          trigger={
            <div data-component="edit-trigger">
              <div data-slot="message-part-title-area" data-path={props.input.filePath}>
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">
                    <TextShimmer text={i18n.t("transcript.messagePart.title.edit")} active={pending()} />
                  </span>
                  <Show when={filename()}>
                    <span data-slot="message-part-title-filename">{filename()}</span>
                  </Show>
                </div>
                <Show when={props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">
                <Show when={!pending() && props.metadata.filediff}>
                  <DiffChanges changes={props.metadata.filediff} />
                </Show>
              </div>
            </div>
          }
        >
          <Show when={path()}>
            <ToolFileAccordion
              path={path()}
              actions={
                <Show when={!pending() && props.metadata.filediff}>
                  <DiffChanges changes={props.metadata.filediff} />
                </Show>
              }
            >
              <div
                data-component="edit-content" class="ui-edit-content"
                data-virtualized={props.virtualizeDiff ? "true" : undefined}
                style={props.virtualizeDiff ? virtualizedDiffViewport : undefined}
              >
                <FrameDeferred
                  content={() => (
                    <Dynamic
                      component={fileComponent}
                      mode="diff"
                      virtualize={props.virtualizeDiff}
                      tokenizeMaxLength={props.virtualizeDiff ? 120 : undefined}
                      onRendered={props.onContentRendered}
                      {...fileCompProps()}
                    />
                  )}
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "write",
  render(props) {
    const i18n = useTranscriptI18n()
    const fileComponent = useFileComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const path = createMemo(() => props.input.filePath || "")
    const filename = () => getFilename(props.input.filePath ?? "")
    const pending = () => props.status === "pending" || props.status === "running"
    return (
      <div data-component="write-tool">
        <BasicTool
          {...props}
          icon="file"
          defer={props.deferContent !== false}
          trigger={
            <div data-component="write-trigger" class="ui-write-trigger">
              <div data-slot="message-part-title-area" data-path={props.input.filePath}>
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">
                    <TextShimmer text={i18n.t("transcript.messagePart.title.write")} active={pending()} />
                  </span>
                  <Show when={filename()}>
                    <span data-slot="message-part-title-filename">{filename()}</span>
                  </Show>
                </div>
                <Show when={props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions"></div>
            </div>
          }
        >
          <Show when={props.input.content && path()}>
            <ToolFileAccordion path={path()}>
              <div class="ui-write-content">
                <Dynamic
                  component={fileComponent}
                  mode="text"
                  file={{
                    name: props.input.filePath,
                    contents: props.input.content,
                    cacheKey: checksum(props.input.content),
                  }}
                  overflow="scroll"
                  onRendered={props.onContentRendered}
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "apply_patch",
  render(props) {
    const i18n = useTranscriptI18n()
    const fileComponent = useFileComponent()
    const files = createMemo(() => patchFiles(props.metadata.files, props.bodyPending))
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const single = createMemo(() => {
      const list = files()
      if (list.length !== 1) return undefined
      return list[0]
    })
    const [expanded, setExpanded] = createSignal<string[]>([])
    let seeded = false

    createEffect(() => {
      const list = files()
      if (list.length === 0) return
      if (seeded) return
      seeded = true
      setExpanded(list.filter((f) => f.type !== "delete").map((f) => f.filePath))
    })

    const subtitle = createMemo(() => {
      const count = files().length
      if (count === 0) return ""
      return `${count} ${i18n.t(count > 1 ? "transcript.common.file.other" : "transcript.common.file.one")}`
    })

    return (
      <Show
        when={single()}
        fallback={
          <div data-component="apply-patch-tool">
            <BasicTool
              {...props}
              icon="pencil-line"
              defer={props.deferContent !== false}
              trigger={{
                title: i18n.t("transcript.tool.patch"),
                subtitle: subtitle(),
              }}
            >
              <Show when={files().length > 0}>
                <Accordion
                  multiple
                  data-scope="apply-patch"
                  style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}
                  value={expanded()}
                  onChange={(value) => setExpanded(Array.isArray(value) ? value : value ? [value] : [])}
                >
                  <For each={files()}>
                    {(file) => {
                      const active = createMemo(() => expanded().includes(file.filePath))
                      const [visible, setVisible] = createSignal(false)

                      createEffect(() => {
                        if (!active()) {
                          setVisible(false)
                          return
                        }

                        requestAnimationFrame(() => {
                          if (!active()) return
                          setVisible(true)
                        })
                      })

                      return (
                        <Accordion.Item value={file.filePath} data-type={file.type}>
                          <StickyAccordionHeader>
                            <Accordion.Trigger>
                              <div data-slot="apply-patch-trigger-content">
                                <div data-slot="apply-patch-file-info">
                                  <FileIcon node={{ path: file.relativePath, type: "file" }} />
                                  <div data-slot="apply-patch-file-name-container">
                                    <Show when={file.relativePath.includes("/")}>
                                      <span data-slot="apply-patch-directory">{`\u202A${getDirectory(file.relativePath)}\u202C`}</span>
                                    </Show>
                                    <span data-slot="apply-patch-filename">{getFilename(file.relativePath)}</span>
                                  </div>
                                </div>
                                <div data-slot="apply-patch-trigger-actions">
                                  <Switch>
                                    <Match when={file.type === "add"}>
                                      <span data-slot="apply-patch-change" data-type="added">
                                        {i18n.t("transcript.patch.action.created")}
                                      </span>
                                    </Match>
                                    <Match when={file.type === "delete"}>
                                      <span data-slot="apply-patch-change" data-type="removed">
                                        {i18n.t("transcript.patch.action.deleted")}
                                      </span>
                                    </Match>
                                    <Match when={file.type === "move"}>
                                      <span data-slot="apply-patch-change" data-type="modified">
                                        {i18n.t("transcript.patch.action.moved")}
                                      </span>
                                    </Match>
                                    <Match when={true}>
                                      <DiffChanges changes={{ additions: file.additions, deletions: file.deletions }} />
                                    </Match>
                                  </Switch>
                                </div>
                              </div>
                            </Accordion.Trigger>
                          </StickyAccordionHeader>
                          <Accordion.Content>
                            <Show when={props.deferContent === false || visible()}>
                              <div
                                data-component="apply-patch-file-diff"
                                data-virtualized={props.virtualizeDiff ? "true" : undefined}
                                style={props.virtualizeDiff ? virtualizedDiffViewport : undefined}
                              >
                                <Dynamic
                                  component={fileComponent}
                                  mode="diff"
                                  virtualize={props.virtualizeDiff}
                                  fileDiff={file.view.fileDiff}
                                  hunkSeparators={file.view.fileDiff.isPartial ? "simple" : "line-info-basic"}
                                  onRendered={props.onContentRendered}
                                />
                              </div>
                            </Show>
                          </Accordion.Content>
                        </Accordion.Item>
                      )
                    }}
                  </For>
                </Accordion>
              </Show>
            </BasicTool>
          </div>
        }
      >
        <div data-component="apply-patch-tool">
          <BasicTool
            {...props}
            icon="pencil-line"
            defer={props.deferContent !== false}
            trigger={
              <div data-component="edit-trigger">
                <div data-slot="message-part-title-area" data-path={single()?.relativePath}>
                  <div data-slot="message-part-title">
                    <span data-slot="message-part-title-text">
                      <TextShimmer text={i18n.t("transcript.tool.patch")} active={pending()} />
                    </span>
                    <Show when={!pending()}>
                      <span data-slot="message-part-title-filename">{getFilename(single()!.relativePath)}</span>
                    </Show>
                  </div>
                  <Show when={!pending() && single()!.relativePath.includes("/")}>
                    <div data-slot="message-part-path">
                      <span data-slot="message-part-directory">{getDirectory(single()!.relativePath)}</span>
                    </div>
                  </Show>
                </div>
                <div data-slot="message-part-actions">
                  <Show when={!pending()}>
                    <DiffChanges changes={{ additions: single()!.additions, deletions: single()!.deletions }} />
                  </Show>
                </div>
              </div>
            }
          >
            <ToolFileAccordion
              path={single()!.relativePath}
              actions={
                <Switch>
                  <Match when={single()!.type === "add"}>
                    <span data-slot="apply-patch-change" data-type="added">
                      {i18n.t("transcript.patch.action.created")}
                    </span>
                  </Match>
                  <Match when={single()!.type === "delete"}>
                    <span data-slot="apply-patch-change" data-type="removed">
                      {i18n.t("transcript.patch.action.deleted")}
                    </span>
                  </Match>
                  <Match when={single()!.type === "move"}>
                    <span data-slot="apply-patch-change" data-type="modified">
                      {i18n.t("transcript.patch.action.moved")}
                    </span>
                  </Match>
                  <Match when={true}>
                    <DiffChanges changes={{ additions: single()!.additions, deletions: single()!.deletions }} />
                  </Match>
                </Switch>
              }
            >
              <div
                data-component="apply-patch-file-diff"
                data-virtualized={props.virtualizeDiff ? "true" : undefined}
                style={props.virtualizeDiff ? virtualizedDiffViewport : undefined}
              >
                <Dynamic
                  component={fileComponent}
                  mode="diff"
                  virtualize={props.virtualizeDiff}
                  fileDiff={single()!.view.fileDiff}
                  onRendered={props.onContentRendered}
                />
              </div>
            </ToolFileAccordion>
          </BasicTool>
        </div>
      </Show>
    )
  },
})

ToolRegistry.register({
  name: "todowrite",
  render(props) {
    const i18n = useTranscriptI18n()
    const todos = createMemo(() => {
      const meta = props.metadata?.todos
      if (Array.isArray(meta)) return meta

      const input = props.input.todos
      if (Array.isArray(input)) return input

      return []
    })

    const subtitle = createMemo(() => {
      const list = todos()
      if (list.length === 0) return ""
      return `${list.filter((t: AgentTodo) => t.status === "completed").length}/${list.length}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="checklist"
        trigger={{
          title: i18n.t("transcript.tool.todos"),
          subtitle: subtitle(),
        }}
      >
        <Show when={todos().length}>
          <div class="ui-todos">
            <For each={todos()}>
              {(todo: AgentTodo) => (
                <Checkbox
                  readOnly
                  checked={todo.status === "completed"}
                  label={
                    <span
                      class="ui-message-part-todo-content"
                      data-completed={todo.status === "completed" ? "completed" : undefined}
                    >
                      {todo.content}
                    </span>
                  }
                />
              )}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "question",
  render(props) {
    const questions = createMemo((): AgentQuestionInfo[] =>
      Array.isArray(props.input.questions) ? props.input.questions : [],
    )
    const answers = createMemo((): AgentQuestionAnswer[] =>
      Array.isArray(props.metadata.answers) ? props.metadata.answers : [],
    )

    return <QuestionCard questions={questions()} answers={answers()} />
  },
})

ToolRegistry.register({
  name: "skill",
  render(props) {
    const i18n = useTranscriptI18n()
    const name = createMemo(() => props.input.name || props.input.skill)
    const title = createMemo(() => name() || i18n.t("transcript.tool.skill"))
    const running = createMemo(() => props.status === "pending" || props.status === "running")

    const titleContent = () => <TextShimmer text={title()} active={running()} />

    const trigger = () => (
      <div data-slot="basic-tool-tool-info-structured">
        <div data-slot="basic-tool-tool-info-main">
          <span data-slot="basic-tool-tool-title" class="capitalize agent-title">
            {titleContent()}
          </span>
        </div>
      </div>
    )

    const body = createMemo(() => props.output || (name() ? `Skill: ${name()}` : undefined))

    return (
      <BasicTool {...props} icon="brain" trigger={trigger()}>
        <Show when={body()}>
          <ScrollableOutput component="tool-output" revealed={props.revealed} onRevealedChange={props.onRevealedChange}>
            <Markdown text={body()!} />
          </ScrollableOutput>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "enterplanmode",
  render(props) {
    const i18n = useTranscriptI18n()
    return <BasicTool {...props} icon="checklist" trigger={{ title: i18n.t("transcript.tool.plan.entered") }} />
  },
})

ToolRegistry.register({
  name: "exitplanmode",
  render(props) {
    const i18n = useTranscriptI18n()
    const plan = createMemo(() => readPlanToolInput(props.input))
    const open = (event: MouseEvent) => {
      const markdown = plan().markdown
      if (!markdown || !props.sessionId || !props.toolCallId) return
      dispatchPlanOpen(event.currentTarget, {
        sessionId: props.sessionId,
        planId: props.toolCallId,
        title: plan().title,
        markdown,
      })
    }
    return (
      <BasicTool
        {...props}
        icon="checklist"
        onSubtitleClick={plan().markdown ? open : undefined}
        trigger={{
          title: i18n.t("transcript.tool.plan.planned"),
          subtitle: plan().title,
          action: plan().markdown ? (
            <IconButton
              icon={<Icon name="open-file" size="small" />}
              variant="ghost"
              size="small"
              aria-label={i18n.t("transcript.tool.plan.open")}
              title={i18n.t("transcript.tool.plan.open")}
              onClick={(event: MouseEvent) => {
                event.stopPropagation()
                open(event)
              }}
            />
          ) : undefined,
        }}
      >
        <Show when={plan().markdown}>
          {(markdown) => (
            <ScrollableOutput component="tool-output" revealed={props.revealed} onRevealedChange={props.onRevealedChange}>
              <Markdown text={markdown()} />
            </ScrollableOutput>
          )}
        </Show>
      </BasicTool>
    )
  },
})

for (const [alias, target] of toolNameAliases()) {
  if (ToolRegistry.render(alias)) continue
  const render = ToolRegistry.render(target)
  if (render) ToolRegistry.register({ name: alias, render })
}
