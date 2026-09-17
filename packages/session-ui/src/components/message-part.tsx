import { toolNameAliases } from "@claxedo/agent-runtime-contract"
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
import { useData } from "../context"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type UiI18n, useI18n } from "@opencode-ai/ui/context/i18n"
import { BasicTool, GenericTool, shellExitCode, ToolExitCode } from "./basic-tool"
import { ScrollableOutput } from "./scrollable-output"
import { groupParts, isHiddenTool, isPendingQuestion, isSubagentToolPart, sameGroups, type PartGroup, type PartRef } from "./part-groups"
import { assistantMessageSettled, countFoldableGroups, foldedGroupKeys, turnFoldDecision } from "./turn-fold"
import { TurnFoldRow } from "./turn-fold-row"
import { workGroupActiveLabel, workGroupIcon, workGroupSummary, workGroupTitle } from "./work-group-summary"
import { SubagentChipRow } from "./subagent-chip"
import { Accordion } from "@opencode-ai/ui/accordion"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { ToolErrorCard } from "./tool-error-card"
import { ClaxedoTool } from "./claxedo-tool"
import { claxedoToolName, claxedoToolTitle, claxedoToolView } from "./claxedo-tool-view"
import { QuestionCard } from "./question-card"
import { isQuestionDeclined } from "./question-result"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { Markdown } from "./markdown"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { getDirectory as _getDirectory, getFilename } from "@opencode-ai/ui/utils/path"
import { AttachmentCardV2 } from "../v2/components/attachment-card-v2"
import { CommentCardV2 } from "../v2/components/comment-card-v2"
import { checksum } from "@opencode-ai/ui/utils/encode"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { formatDuration } from "./format-duration"
import { localPreviewUrl } from "./local-preview"
import { stripShellWrapper } from "./shell-wrapper"
import { AnimatedCountList } from "./tool-count-summary"
import { ToolStatusTitle } from "./tool-status-title"
import { patchFiles } from "./apply-patch-file"
import { animate } from "motion"
import { useLocation } from "@solidjs/router"
import { attached, inline, kind, typeLabel } from "./message-file"
import { readPartText } from "./message-part-text"
import { shouldRenderUserMarkdown } from "./user-message-markdown"
import { handleTranscriptLinkClick, transcriptLinks } from "./transcript-link"

async function writeClipboard(text: string): Promise<boolean> {
  const body = typeof document === "undefined" ? undefined : document.body
  if (body) {
    const textarea = document.createElement("textarea")
    textarea.value = text
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    textarea.style.pointerEvents = "none"
    body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand("copy")
    body.removeChild(textarea)
    if (copied) return true
  }

  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard?.writeText) return false
  return clipboard.writeText(text).then(
    () => true,
    () => false,
  )
}

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

interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  message: string
  severity?: number
}

interface DiagnosticsResult {
  items: Diagnostic[]
  /** Total error-severity diagnostics before the cap was applied. */
  total: number
}

const DIAGNOSTICS_CAP = 3

function getDiagnostics(
  diagnosticsByFile: Record<string, Diagnostic[]> | undefined,
  filePath: string | undefined,
): DiagnosticsResult {
  if (!diagnosticsByFile || !filePath) return { items: [], total: 0 }
  const diagnostics = diagnosticsByFile[filePath] ?? []
  const errors = diagnostics.filter((d) => d.severity === 1)
  return { items: errors.slice(0, DIAGNOSTICS_CAP), total: errors.length }
}

function DiagnosticsDisplay(props: { diagnostics: DiagnosticsResult }): JSX.Element {
  const i18n = useI18n()
  const overflow = () => props.diagnostics.total - props.diagnostics.items.length
  return (
    <Show when={props.diagnostics.items.length > 0}>
      <div data-component="diagnostics" class="ui-diagnostics">
        <For each={props.diagnostics.items}>
          {(diagnostic) => (
            <div data-slot="diagnostic">
              <span data-slot="diagnostic-icon" class="ui-diagnostic-icon" aria-label={i18n.t("ui.messagePart.diagnostic.error")}>
                <Icon name="circle-ban-sign" size="small" />
              </span>
              <span data-slot="diagnostic-location" class="ui-diagnostic-location">
                [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
              </span>
              <span data-slot="diagnostic-message" class="ui-diagnostic-message">{diagnostic.message}</span>
            </div>
          )}
        </For>
        <Show when={overflow() > 0}>
          <div data-slot="diagnostic-overflow" class="ui-diagnostic-overflow">{i18n.t("ui.messagePart.diagnostic.more", { count: overflow() })}</div>
        </Show>
      </div>
    </Show>
  )
}

export interface MessageProps {
  message: AgentPresentationMessage
  parts: AgentContentPart[]
  actions?: UserActions
  showAssistantCopyPartID?: string | null
  showReasoningSummaries?: boolean
  useV2Actions?: boolean
  comments?: UserMessageComment[]
}

export type SessionAction = (input: { sessionID: string; messageID: string }) => Promise<void> | void

export type UserActions = {
  fork?: SessionAction
  revert?: SessionAction
  openAttachment?: (file: AgentFilePart) => void
}

export type UserMessageComment = {
  path: string
  comment: string
  selection?: {
    startLine: number
    endLine: number
  }
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
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  /**
   * Turn-level abort signal supplied by the timeline. SDK-runtime harnesses
   * (codex/claude/cursor/ACP) never stamp MessageAbortedError on abort — they leave the
   * turn's last assistant message unsettled — so `message.error` alone under-detects
   * interruptions; only the caller can see the whole turn plus session status.
   */
  turnInterrupted?: boolean
  useV2Actions?: boolean
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
    useV2?: boolean
  },
) {
  const icon = () => (props.icon === "copy" ? "outline-copy" : props.icon)
  return (
    <Show
      when={props.useV2}
      fallback={
        <Tooltip value={props.label} placement="top" gutter={4}>
          <IconButton
            icon={props.icon}
            size="normal"
            variant="ghost"
            disabled={props.disabled}
            onMouseDown={props.onMouseDown}
            onClick={props.onClick}
            aria-label={props["aria-label"]}
          />
        </Tooltip>
      }
    >
      <TooltipV2 value={props.label} placement="top" gutter={4}>
        <IconButtonV2
          icon={<IconV2 name={icon()} size="small" />}
          size="normal"
          variant="ghost-muted"
          disabled={props.disabled}
          onMouseDown={props.onMouseDown}
          onClick={props.onClick}
          aria-label={props["aria-label"]}
        />
      </TooltipV2>
    </Show>
  )
}

export type PartComponent = Component<MessagePartProps>

export const PART_MAPPING: Record<string, PartComponent | undefined> = {}

/**
 * Every renderer below is registered under exactly one `part.type`, so `Part` only ever
 * hands it that variant. The registry's value type is the wide `MessagePartProps`, so each
 * renderer restates the invariant by checking the discriminant — which is also what lets
 * TypeScript narrow the union. Reaching the throw means the registry was wired wrong.
 */
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

import type { IconProps } from "@opencode-ai/ui/icon"
import { resolveFileDiff } from "./session-diff"

export type ToolInfo = {
  icon: IconProps["name"]
  title: string
  subtitle?: string
  /** Secondary `key=value` chips, shown after the subtitle. */
  args?: string[]
}

function agentTitle(i18n: UiI18n, type?: string) {
  if (!type) return i18n.t("ui.tool.agent.default")
  return i18n.t("ui.tool.agent", { type })
}

function newLayout() {
  return typeof document !== "undefined" && document.body.hasAttribute("data-new-layout")
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
  const i18n = useI18n()
  switch (tool) {
    case "read": {
      const args: string[] = []
      if (input.offset) args.push("offset=" + input.offset)
      if (input.limit) args.push("limit=" + input.limit)
      return {
        icon: "glasses",
        title: i18n.t("ui.tool.read"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
        args,
      }
    }
    case "list":
      return {
        icon: "bullet-list",
        title: i18n.t("ui.tool.list"),
        subtitle: getDirectory(input.path || "/"),
      }
    case "glob":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.glob"),
        subtitle: getDirectory(input.path || "/"),
        args: input.pattern ? ["pattern=" + input.pattern] : [],
      }
    case "grep": {
      const args: string[] = []
      if (input.pattern) args.push("pattern=" + input.pattern)
      if (input.include) args.push("include=" + input.include)
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.grep"),
        subtitle: getDirectory(input.path || "/"),
        args,
      }
    }
    case "webfetch":
      return {
        icon: "magnifying-glass",
        title: i18n.t("ui.tool.webfetch"),
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
        title: i18n.t("ui.tool.shell"),
        subtitle: input.command,
      }
    case "edit":
      return {
        icon: "pencil-line",
        title: i18n.t("ui.messagePart.title.edit"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "write":
      return {
        icon: "file",
        title: i18n.t("ui.messagePart.title.write"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "apply_patch":
      return {
        icon: "pencil-line",
        title: i18n.t("ui.tool.patch"),
        subtitle: input.files?.length
          ? `${input.files.length} ${i18n.t(input.files.length > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
          : undefined,
      }
    case "todowrite":
      return {
        icon: "checklist",
        title: i18n.t("ui.tool.todos"),
      }
    case "question":
      return {
        icon: "bubble-5",
        title: i18n.t("ui.tool.questions"),
      }
    case "skill":
      return {
        icon: "brain",
        title: input.name || input.skill || i18n.t("ui.tool.skill"),
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

function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
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

function toolDefaultOpen(tool: string, shell = false, edit = false): boolean | undefined {
  if (tool === "bash") return shell
  if (tool === "edit" || tool === "write" || tool === "apply_patch") return edit
  return undefined
}

export function partDefaultOpen(part: AgentContentPart, shell = false, edit = false): boolean | undefined {
  if (part.type !== "tool") return undefined
  return toolDefaultOpen(part.tool, shell, edit)
}

type GroupMember = { message: AgentAssistantMessage; part: AgentToolPart }

type PartGroupSlots = {
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  useV2Actions?: boolean
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
}

function PartGroups(
  props: PartGroupSlots & {
    groups: PartGroup[]
    message: (messageID: string) => AgentAssistantMessage | undefined
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
        const message = props.message(ref.messageID)
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
                          useV2Actions={props.useV2Actions}
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
                  return props.message(entry.ref.messageID)
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
                            showAssistantCopyPartID={props.showAssistantCopyPartID}
                            turnDurationMs={props.turnDurationMs}
                            useV2Actions={props.useV2Actions}
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

export function AssistantParts(
  props: PartGroupSlots & {
    messages: AgentAssistantMessage[]
    working?: boolean
    showReasoningSummaries?: boolean
    /** Folds a settled turn's machinery behind one "Worked for Xs" divider. */
    foldSettledTurn?: boolean
    turnInterrupted?: boolean
    turnErrored?: boolean
  },
) {
  const data = useData()
  const emptyParts: AgentContentPart[] = []
  const msgs = createMemo(() => index(props.messages))
  const part = createMemo(
    () =>
      new Map(
        props.messages.map((message) => [message.id, index(list(data.store.part?.[message.id], emptyParts))] as const),
      ),
  )

  const grouped = createMemo(
    () =>
      groupParts(
        props.messages.flatMap((message) =>
          list(data.store.part?.[message.id], emptyParts)
            .filter((part) => renderable(part, props.showReasoningSummaries ?? true))
            .map((part) => ({
              messageID: message.id,
              part,
            })),
        ),
      ),
    [] as PartGroup[],
    { equals: sameGroups },
  )

  const last = createMemo(() => grouped().at(-1)?.key)

  const partOf = (ref: PartRef) => part().get(ref.messageID)?.get(ref.partID)
  const [foldChoice, setFoldChoice] = createSignal<boolean | undefined>(undefined)
  const settled = createMemo(() => props.messages.some(assistantMessageSettled))
  const foldableCount = createMemo(() => countFoldableGroups(grouped(), partOf))
  const fold = createMemo(() =>
    turnFoldDecision({
      foldableCount: foldableCount(),
      settled: settled(),
      interrupted: props.turnInterrupted,
      errored: props.turnErrored,
      busy: props.working,
      foldWhenSettled: props.foldSettledTurn,
      userChoice: foldChoice(),
    }),
  )
  const folded = createMemo(() => foldedGroupKeys(fold(), grouped(), partOf))
  const visibleGroups = createMemo(() => {
    const keys = folded()
    return keys.size === 0 ? grouped() : grouped().filter((group) => !keys.has(group.key))
  })

  return (
    <>
      <Show when={fold().canFold}>
        <TurnFoldRow
          durationMs={props.turnDurationMs}
          folded={fold().folded}
          onToggle={() => setFoldChoice(!fold().folded)}
        />
      </Show>
      <PartGroups
        groups={visibleGroups()}
        message={(messageID) => msgs().get(messageID)}
        part={partOf}
        busyGroupKey={props.working ? last() : undefined}
        showAssistantCopyPartID={props.showAssistantCopyPartID}
        turnDurationMs={props.turnDurationMs}
        useV2Actions={props.useV2Actions}
        shellToolDefaultOpen={props.shellToolDefaultOpen}
        editToolDefaultOpen={props.editToolDefaultOpen}
      />
    </>
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
      <div data-component="exa-tool-output" class="ui-exa-tool-output">
        <div data-slot="exa-tool-links">
          <For each={links()}>
            {(url) => (
              <a
                data-slot="exa-tool-link" class="ui-exa-tool-link"
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

export function registerPartComponent(type: string, component: PartComponent) {
  PART_MAPPING[type] = component
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
          <UserMessageDisplay
            message={message()}
            parts={props.parts}
            actions={props.actions}
            useV2Actions={props.useV2Actions}
            comments={props.comments}
          />
        )}
      </Match>
      <Match when={assistantMessage(props.message)}>
        {(message) => (
          <AssistantMessageDisplay
            message={message()}
            parts={props.parts}
            showAssistantCopyPartID={props.showAssistantCopyPartID}
            showReasoningSummaries={props.showReasoningSummaries}
            useV2Actions={props.useV2Actions}
          />
        )}
      </Match>
    </Switch>
  )
}

export function AssistantMessageDisplay(props: {
  message: AgentAssistantMessage
  parts: AgentContentPart[]
  showAssistantCopyPartID?: string | null
  showReasoningSummaries?: boolean
  useV2Actions?: boolean
}) {
  const part = createMemo(() => index(props.parts))
  const grouped = createMemo(
    () =>
      groupParts(
        props.parts
          .filter((part) => renderable(part, props.showReasoningSummaries ?? true))
          .map((part) => ({
            messageID: props.message.id,
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
      part={(ref) => part().get(ref.partID)}
      showAssistantCopyPartID={props.showAssistantCopyPartID}
      useV2Actions={props.useV2Actions}
    />
  )
}

/**
 * A run of read/list/glob/grep folded to one "Explored" line. `parts` drives the header
 * counts only; the member rows are passed in as children and render through their own
 * tool renderers, so an expanded group holds ordinary tool rows.
 */
export function ContextToolGroup(props: {
  parts: AgentToolPart[]
  busy?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSizeChange?: () => void
  children: JSX.Element
}) {
  const i18n = useI18n()
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
            <span data-slot="context-tool-group-label" class="shrink-0">
              <ToolStatusTitle
                active={pending()}
                activeText={i18n.t("ui.sessionTurn.status.gatheringContext")}
                doneText={i18n.t("ui.sessionTurn.status.gatheredContext")}
                split={false}
              />
            </span>
            <span
              data-slot="context-tool-group-summary"
              class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-text-base"
            >
              <AnimatedCountList
                items={[
                  {
                    key: "read",
                    count: summary().read,
                    one: i18n.t("ui.messagePart.context.read.one"),
                    other: i18n.t("ui.messagePart.context.read.other"),
                  },
                  {
                    key: "search",
                    count: summary().search,
                    one: i18n.t("ui.messagePart.context.search.one"),
                    other: i18n.t("ui.messagePart.context.search.other"),
                  },
                  {
                    key: "list",
                    count: summary().list,
                    one: i18n.t("ui.messagePart.context.list.one"),
                    other: i18n.t("ui.messagePart.context.list.other"),
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

/**
 * WorkGroup — generalizes ContextToolGroup for a run of anything the agent did.
 * Collapsed by default; header = category icon + segmented summary + gated chevron.
 * Expanded body is a 224px scroll region with edge fades when it overflows; member rows
 * are passed in as children (the app renders them so per-part open state persists) and retain
 * their tool-specific icons so the expanded list identifies each operation.
 */
export function WorkGroup(props: {
  parts: AgentToolPart[]
  busy?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSizeChange?: () => void
  children: JSX.Element
}) {
  const i18n = useI18n()
  const [localOpen, setLocalOpen] = createSignal(false)
  const [overflowing, setOverflowing] = createSignal(false)
  const open = () => props.open ?? localOpen()
  const pending = createMemo(
    () =>
      !!props.busy || props.parts.some((part) => part.state.status === "pending" || part.state.status === "running"),
  )
  const summary = createMemo(() => workGroupSummary(props.parts))
  const icon = createMemo(() => workGroupIcon(props.parts))
  // Stay active between members until execution moves past this group.
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
          <span data-slot="work-group-summary" class="ui-work-group-summary">
            <TextShimmer text={title()} active={pending()} />
          </span>
          <Collapsible.Arrow />
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div
          ref={listRef}
          data-component="work-group-list" class="ui-work-group-list"
          data-scrollable
          data-overflowing={overflowing() ? "true" : undefined}
        >
          {props.children}
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}

function UserMessageComments(props: { comments: UserMessageComment[]; bounded: boolean }) {
  const i18n = useI18n()
  const [state, setState] = createStore({ expanded: false })
  const comments = createMemo(() => (props.bounded && !state.expanded ? props.comments.slice(0, 5) : props.comments))

  return (
    <div data-slot="user-message-comments" data-bounded={props.bounded ? "true" : undefined}>
      <For each={comments()}>
        {(comment) => (
          <CommentCardV2
            comment={comment.comment}
            path={comment.path}
            selection={comment.selection}
            title={comment.comment}
            tooltip
            wide
          />
        )}
      </For>
      <Show when={props.bounded && props.comments.length > 5 && !state.expanded}>
        <ButtonV2 size="small" variant="ghost-muted" onClick={() => setState("expanded", true)}>
          {i18n.t("ui.common.showMore")}
        </ButtonV2>
      </Show>
    </div>
  )
}

export function UserMessageDisplay(props: {
  message: AgentUserMessage
  parts: AgentContentPart[]
  actions?: UserActions
  useV2Actions?: boolean
  comments?: UserMessageComment[]
}) {
  const data = useData()
  const i18n = useI18n()
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

  const messageComments = createMemo(() => (newLayout() ? (props.comments ?? []) : []))

  const inlineFiles = createMemo(() => files().filter(inline))

  const agents = createMemo(() => props.parts?.filter((part) => part.type === "agent") ?? [])

  const renderAsMarkdown = createMemo(
    () => shouldRenderUserMarkdown(text()) && inlineFiles().length === 0 && agents().length === 0,
  )

  const model = createMemo(() => {
    const providerID = props.message.model?.providerID
    const modelID = props.message.model?.modelID
    if (!providerID || !modelID) return ""
    const match = data.store.provider?.all?.get(providerID)
    return match?.models?.[modelID]?.name ?? modelID
  })
  const timefmt = createMemo(() => new Intl.DateTimeFormat(i18n.locale(), { timeStyle: "short" }))

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
    if (await writeClipboard(content)) {
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
          sessionID: props.message.sessionID,
          messageID: props.message.id,
        }),
      )
      .finally(() => setState("busy", false))
  }

  const renderAttachments = () => (
    <Show when={attachments().length > 0}>
      <div data-slot="user-message-attachments" class="ui-user-message-attachments">
        <For each={attachments()}>
          {(file) => {
            const type = kind(file)
            const name = file.filename ?? i18n.t("ui.message.attachment.alt")

            return (
              <Show
                when={newLayout() && type === "file"}
                fallback={
                  <div
                    data-slot="user-message-attachment" class="ui-user-message-attachment"
                    data-type={type}
                    data-clickable={type === "image" ? "true" : undefined}
                    title={type === "file" ? name : undefined}
                    onClick={() => {
                      if (type === "image") openImagePreview(file.url, name)
                    }}
                  >
                    <Show
                      when={type === "image"}
                      fallback={
                        <div data-slot="user-message-attachment-file">
                          <FileIcon node={{ path: name, type: "file" }} />
                          <span data-slot="user-message-attachment-name" class="ui-user-message-attachment-name">{name}</span>
                        </div>
                      }
                    >
                      <img data-slot="user-message-attachment-image" src={file.url} alt={name} />
                    </Show>
                  </div>
                }
              >
                <AttachmentCardV2
                  title={getFilename(name)}
                  hover={name}
                  clickable={!!props.actions?.openAttachment}
                  onClick={() => props.actions?.openAttachment?.(file)}
                >
                  {typeLabel(name, file.mime)}
                </AttachmentCardV2>
              </Show>
            )
          }}
        </For>
      </div>
    </Show>
  )

  return (
    <div data-component="user-message" class="ui-user-message" data-timeline-part-id={textPart()?.id}>
      <Show when={!props.useV2Actions}>{renderAttachments()}</Show>
      <Show
        when={text()}
        fallback={
          <Show when={messageComments().length > 0}>
            <UserMessageComments comments={messageComments()} bounded={false} />
          </Show>
        }
      >
        <div data-slot="user-message-body" class="ui-user-message-body" data-markdown={renderAsMarkdown() ? "true" : undefined}>
          <div
            data-slot="user-message-text" class="ui-user-message-text"
            data-comments={messageComments().length > 0 ? "true" : undefined}
            data-markdown={renderAsMarkdown() ? "true" : undefined}
          >
            <Show
              when={renderAsMarkdown()}
              fallback={<HighlightedText text={text()} references={inlineFiles()} agents={agents()} />}
            >
              <Markdown text={text()} cacheKey={textPart()?.id} streaming={false} />
            </Show>
            <Show when={messageComments().length > 0}>
              <UserMessageComments comments={messageComments()} bounded />
            </Show>
          </div>
        </div>
      </Show>
      <Show when={props.useV2Actions}>{renderAttachments()}</Show>
      <Show when={text() || (props.useV2Actions && messageComments().length > 0)}>
        <div data-slot="user-message-copy-wrapper" class="ui-user-message-copy-wrapper">
          <Show when={metaHead() || metaTail()}>
            <span data-slot="user-message-meta-wrap">
              <Show when={metaHead()}>
                <span data-slot="user-message-meta" class="text-12-regular text-text-weak cursor-default">
                  {metaHead()}
                </span>
              </Show>
              <Show when={metaHead() && metaTail()}>
                <span data-slot="user-message-meta-sep" class="text-12-regular text-text-weak cursor-default">
                  {"\u00A0\u00B7\u00A0"}
                </span>
              </Show>
              <Show when={metaTail()}>
                <span data-slot="user-message-meta-tail" class="text-12-regular text-text-weak cursor-default">
                  {metaTail()}
                </span>
              </Show>
            </span>
          </Show>
          <Show when={props.actions?.revert}>
            <MessageActionButton
              icon="reset"
              label={i18n.t("ui.message.revertMessage")}
              useV2={props.useV2Actions}
              disabled={busy()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                revert()
              }}
              aria-label={i18n.t("ui.message.revertMessage")}
            />
          </Show>
          <Show when={text()}>
            <MessageActionButton
              icon={copied() ? "check" : "copy"}
              label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyMessage")}
              useV2={props.useV2Actions}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                void handleCopy()
              }}
              aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyMessage")}
            />
          </Show>
        </div>
      </Show>
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
  const component = createMemo(() => PART_MAPPING[props.part.type])
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
        showAssistantCopyPartID={props.showAssistantCopyPartID}
        turnDurationMs={props.turnDurationMs}
        turnInterrupted={props.turnInterrupted}
        useV2Actions={props.useV2Actions}
      />
    </Show>
  )
}

export interface ToolProps {
  input: Record<string, any>
  metadata: Record<string, any>
  tool: string
  toolCallId?: string
  sessionID?: string
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
                <Icon name="chevron-down" size="small" data-slot="accordion-caret" />
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
  const i18n = useI18n()
  const part = () => {
    const value = props.part
    if (value.type !== "tool") throw wrongPartType("tool", value)
    return value
  }
  if (part().tool === "todowrite") return null

  const hideQuestion = createMemo(
    () => part().tool === "question" && (part().state.status === "pending" || part().state.status === "running"),
  )

  // The child registry owns whether delegation happened. A wrapper can fail or
  // be interrupted after admitting a child; keep that child's transcript chip.
  const boundSubagents = createMemo(() => isSubagentToolPart(part())
    ? data.resolveSubagents?.(part().sessionID, part().callID) ?? []
    : [])

  /** The failure text of an errored tool call. */
  const toolError = createMemo(() => {
    const state = part().state
    return state.status === "error" ? state.error : undefined
  })

  /** When the call began. A pending call has not started, so it has no timestamp yet. */
  const toolStartedAt = createMemo(() => {
    const state = part().state
    return state.status === "pending" ? undefined : state.time.start
  })

  const emptyInput: Record<string, unknown> = {}
  const emptyMetadata: Record<string, unknown> = {}

  const input = () => part().state.input ?? emptyInput
  /**
   * A pending call has not run, so it carries no metadata at all -- that is the
   * one status `AgentToolState` omits the field from, and reading through it was
   * the error the suppression here used to hide. Every started status declares
   * it, optionally except when completed.
   */
  const partMetadata = () => {
    const state = part().state
    if (state.status === "pending") return emptyMetadata
    return state.metadata ?? emptyMetadata
  }
  /** Output exists only once the call completes; every earlier status has none. */
  const toolOutput = createMemo(() => {
    const state = part().state
    return state.status === "completed" ? state.output : undefined
  })
  /** Like `output`, the contract carries attachments only on a completed call. */
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

  /** The first-party tool this call is, when the registry has no renderer of its own for its spelling. */
  const claxedo = createMemo(() => (ToolRegistry.render(part().tool) ? undefined : claxedoToolName(part().tool, input())))
  /** What a refused first-party call was about, for the error card's subtitle and link. */
  const claxedoSubject = createMemo(() => {
    const name = claxedo()
    if (!name) return undefined
    const view = claxedoToolView({ name, input: input(), output: undefined, i18n })
    if (view.link) {
      const href = view.link.kind === "task" ? data.taskHref?.(view.link.id) : data.sessionHref?.(view.link.id)
      return { subtitle: view.link.label, href }
    }
    return view.subject ? { subtitle: view.subject, href: undefined } : undefined
  })

  const render = createMemo(() => ToolRegistry.render(part().tool) ?? (claxedo() ? ClaxedoTool : GenericTool))
  const controlledOpen = () => (props.onToolOpenChange ? (props.toolOpen ?? props.defaultOpen) : undefined)
  const handleToolOpenChange = (open: boolean) => props.onToolOpenChange?.(open)

  return (
    <Show when={!hideQuestion()}>
      <div data-component="tool-part-wrapper" data-timeline-part-id={part().id}>
        <Switch>
          <Match when={boundSubagents().length > 0}>
            <SubagentChipRow subagents={boundSubagents()} spawnInput={input()} />
          </Match>
          <Match when={toolError()}>
            {(error) => {
              if (part().tool === "question" && isQuestionDeclined(partMetadata())) {
                return (
                  <div style="width: 100%; display: flex; justify-content: flex-end;">
                    <span class="text-13-regular text-text-weak cursor-default">
                      {i18n.t("ui.messagePart.questions.dismissed")}
                    </span>
                  </div>
                )
              }
              return (
                <ToolErrorCard
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
                  onOpenChange={props.onToolOpenChange ? handleToolOpenChange : undefined}
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
              sessionID={part().sessionID}
              metadata={partMetadata()}
              output={toolOutput()}
              status={part().state.status}
              startedAt={toolStartedAt()}
              hideDetails={props.hideDetails}
              defaultOpen={props.defaultOpen}
              open={controlledOpen()}
              onOpenChange={props.onToolOpenChange ? handleToolOpenChange : undefined}
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

export function MessageDivider(props: { label: string; icon?: IconProps["name"] }) {
  return (
    <div data-component="compaction-part">
      <div data-slot="compaction-part-divider">
        <span data-slot="compaction-part-line" />
        <span data-slot="compaction-part-label" class="text-12-regular text-text-weak">
          <Show when={props.icon}>
            <span data-slot="compaction-part-icon">
              <Icon name={props.icon!} size="small" />
            </span>
          </Show>
          {props.label}
        </span>
        <span data-slot="compaction-part-line" />
      </div>
    </div>
  )
}

PART_MAPPING["compaction"] = function CompactionPartDisplay() {
  const i18n = useI18n()
  return <MessageDivider label={i18n.t("ui.messagePart.compaction")} icon="archive" />
}

PART_MAPPING["text"] = function TextPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const numfmt = createMemo(() => new Intl.NumberFormat(i18n.locale()))
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
    const match = data.store.provider?.all?.get(message.providerID)
    return match?.models?.[message.modelID]?.name ?? message.modelID
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
    if (total < 60) return i18n.t("ui.message.duration.seconds", { count: numfmt().format(total) })
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return i18n.t("ui.message.duration.minutesSeconds", {
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
      interrupted() ? i18n.t("ui.message.interrupted") : "",
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
  const text = () => readPartText(data.store.part_text_accum_delta, part())
  const isLastTextPart = createMemo(() => {
    const last = (data.store.part?.[props.message.id] ?? [])
      .filter((item): item is AgentTextPart => item?.type === "text" && !!item.text?.trim())
      .at(-1)
    return last?.id === part().id
  })
  const showCopy = createMemo(() => {
    if (props.message.role !== "assistant") return isLastTextPart()
    if (props.showAssistantCopyPartID === null) return false
    if (typeof props.showAssistantCopyPartID === "string") return props.showAssistantCopyPartID === part().id
    return isLastTextPart()
  })
  const [copied, setCopied] = createSignal(false)

  const handleCopy = async () => {
    const content = text()
    if (!content) return
    if (await writeClipboard(content)) {
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
          <div data-slot="text-part-copy-wrapper" class="ui-text-part-copy-wrapper" data-interrupted={interrupted() ? "" : undefined}>
            <MessageActionButton
              icon={copied() ? "check" : "copy"}
              label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyResponse")}
              useV2={props.useV2Actions}
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleCopy}
              aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyResponse")}
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
  const data = useData()
  const part = () => {
    const value = props.part
    if (value.type !== "reasoning") throw wrongPartType("reasoning", value)
    return value
  }
  const streaming = createMemo(
    () =>
      props.message.role === "assistant" &&
      typeof props.message.time.completed !== "number" &&
      props.turnInterrupted !== true,
  )
  const text = () => readPartText(data.store.part_text_accum_delta, part())
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
      <div data-component="reasoning-part" class="ui-reasoning-part" data-timeline-part-id={part().id}>
        <BasicTool icon="brain" status={streaming() ? "running" : undefined} trigger={{ title: title() }}>
          <div data-component="reasoning-content">
            <PacedMarkdown text={text()} cacheKey={part().id} streaming={streaming()} />
          </div>
        </BasicTool>
      </div>
    </Show>
  )
}

/**
 * Opens an image in the full-view dialog. `show` resolves when Solid's transition
 * settles; nothing here waits on the dialog being on screen, and the transition promise
 * does not reject.
 */
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
        /* A file left on disk is named rather than carried: only the host can turn its
           path into a url this page may fetch, and dropped bytes have no url at all. */
        const src = createMemo(() => {
          const location = image.location
          if (!location) return image.url
          if (location.kind === "unretained") return undefined
          return data.fileUrl?.(location.path)
        })
        return (
          <div data-component="tool-image" class="ui-tool-image">
            <Show when={src()} fallback={<ToolImageUnavailable name={name()} location={image.location} />}>
              {(url) => {
                const [failed, setFailed] = createSignal(false)
                return (
                  <Show when={!failed()} fallback={<ToolImageUnavailable name={name()} location={image.location} />}>
                    <img
                      data-slot="tool-image-thumbnail"
                      src={url()}
                      alt={name()}
                      onError={() => setFailed(true)}
                      onClick={() => openImagePreview(url(), name())}
                    />
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

/**
 * The images a tool call produced. Every adapter harvests an image block from any tool
 * result — a screenshot from an MCP server as readily as a `read` of a png — so this
 * hangs off the tool row itself rather than off the one renderer that can expect them.
 *
 * The strip is a separate component so that a row with no images asks for neither the
 * dialog nor the data context, and `useDialog` throws where there is no provider.
 */
export function ToolAttachments(props: { attachments?: AgentFilePart[] }) {
  const images = createMemo(() => (props.attachments ?? []).filter((file) => file.mime.startsWith("image/")))
  return (
    <Show when={images().length > 0}>
      <ToolImageStrip images={images()} />
    </Show>
  )
}

function ToolImageUnavailable(props: { name: string; location?: AgentFileLocation }) {
  return (
    <div data-slot="tool-image-unavailable" class="ui-tool-image-unavailable">
      <Icon name="photo" size="small" />
      <span>{props.name}</span>
      <Show when={props.location?.kind === "unretained" ? props.location : undefined}>
        {(location) => <span data-slot="tool-image-size">{`${Math.round(location().bytes / 1024)} KB`}</span>}
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

  return (
    <div data-component="file-part" data-timeline-part-id={part().id}>
      <Switch
        fallback={
          <a
            data-slot="file-part-link"
            href={part().url}
            target="_blank"
            rel="noopener noreferrer"
            title={name()}
            onClick={handleTranscriptLinkClick}
          >
            <FileIcon node={{ path: name(), type: "file" }} />
            <span data-slot="file-part-link-name">{name()}</span>
          </a>
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
          <audio data-slot="file-part-audio" controls src={part().url} aria-label={name()} />
        </Match>
      </Switch>
    </div>
  )
}

ToolRegistry.register({
  name: "read",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    // The registered name, not props.tool: an alias (`read_file`) renders here too.
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
            <div data-component="tool-loaded-file" class="ui-tool-loaded-file">
              <Icon name="enter" size="small" />
              <span>
                {i18n.t("ui.tool.loaded")} {relativizeProjectPath(filepath, data.directory)}
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
    const i18n = useI18n()
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const url = createMemo(() => {
      const value = props.input.url
      if (typeof value !== "string") return ""
      return value
    })
    return (
      <BasicTool
        {...props}
        hideDetails
        icon="magnifying-glass"
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.webfetch")} active={pending()} />
              </span>
              <Show when={!pending() && url()}>
                <a
                  data-slot="basic-tool-tool-subtitle"
                  class="clickable subagent-link"
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    event.stopPropagation()
                    handleTranscriptLinkClick(event)
                  }}
                >
                  {url()}
                </a>
              </Show>
            </div>
            <Show when={!pending() && url()}>
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
      props.sessionID ? data.resolveSubagents?.(props.sessionID, props.toolCallId) ?? [] : []
    )
    return <SubagentChipRow subagents={subagents()} spawnInput={props.input} />
  },
})

ToolRegistry.register({
  name: "bash",
  render(props) {
    const i18n = useI18n()
    const pending = () => props.status === "pending" || props.status === "running"
    const sawPending = pending()
    // Row reads "Ran <command>" — verb + the real command, not a static "Shell"
    // label with the login-shell wrapper trailing behind it.
    const displayCommand = createMemo(() =>
      stripShellWrapper(String(props.input.command ?? props.metadata.command ?? "")),
    )
    const text = createMemo(() => {
      const cmd = displayCommand()
      const out = stripAnsi(props.output || props.metadata.output || "").replace(/\r\n?/g, "\n")
      return `$ ${cmd}${out ? "\n\n" + out : ""}`
    })
    const [copied, setCopied] = createSignal(false)

    // Dev-server preview row: surface a "Local preview · 127.0.0.1:port" chip when the
    // command output advertises a listening localhost URL. Pure client-side regex.
    const localUrl = createMemo(() => {
      if (pending()) return undefined
      return localPreviewUrl(stripAnsi(props.output || props.metadata.output || ""))
    })
    const localLabel = () => localUrl()?.replace(/^https?:\/\//, "").replace(/\/$/, "")

    const handleCopy = async () => {
      const content = text()
      if (!content) return
      if (await writeClipboard(content)) {
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
              {/* Keep the command in the header while running and while expanded — the
                  verb alone ("Running") says nothing, and a long command is exactly when
                  the reader needs to know which one it is. The input carries `command` as
                  soon as its partial JSON parses, well before the call returns. */}
              <Show when={displayCommand()}>
                <ShellSubmessage text={displayCommand()} animate={sawPending && !open()} />
              </Show>
              <ToolExitCode code={pending() ? undefined : shellExitCode(props.metadata)} />
            </div>
          </div>
        )}
      >
        <div data-component="bash-output" class="ui-bash-output">
          <div data-slot="bash-copy" class="ui-bash-copy">
            <TooltipV2 value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")} placement="top">
              <IconButtonV2
                icon={<IconV2 name={copied() ? "check" : "outline-copy"} size="small" />}
                size="normal"
                variant="ghost-muted"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCopy}
                aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              />
            </TooltipV2>
          </div>
          <ScrollableOutput slot="bash-scroll" class="ui-bash-scroll" revealed={props.revealed} onRevealedChange={props.onRevealedChange}>
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
          <span data-slot="local-preview-verb" class="ui-local-preview-verb">Local preview</span>
          <span data-slot="local-preview-url" class="ui-local-preview-url">{localLabel()}</span>
        </a>
      </Show>
      </>
    )
  },
})

ToolRegistry.register({
  name: "edit",
  render(props) {
    const i18n = useI18n()
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
      } catch {}

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
                    <TextShimmer text={i18n.t("ui.messagePart.title.edit")} active={pending()} />
                  </span>
                  <Show when={!pending()}>
                    <span data-slot="message-part-title-filename">{filename()}</span>
                  </Show>
                </div>
                <Show when={!pending() && props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">
                <Show when={!pending() && props.metadata.filediff}>
                  <DiffChanges changes={props.metadata.filediff} variant="muted-hover" />
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
    const i18n = useI18n()
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
                    <TextShimmer text={i18n.t("ui.messagePart.title.write")} active={pending()} />
                  </span>
                  <Show when={!pending()}>
                    <span data-slot="message-part-title-filename">{filename()}</span>
                  </Show>
                </div>
                <Show when={!pending() && props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">{/* <DiffChanges diff={diff} /> */}</div>
            </div>
          }
        >
          <Show when={props.input.content && path()}>
            <ToolFileAccordion path={path()}>
              <div data-component="write-content" class="ui-write-content">
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
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const files = createMemo(() => patchFiles(props.metadata.files))
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
      return `${count} ${i18n.t(count > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
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
                title: i18n.t("ui.tool.patch"),
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
                                        {i18n.t("ui.patch.action.created")}
                                      </span>
                                    </Match>
                                    <Match when={file.type === "delete"}>
                                      <span data-slot="apply-patch-change" data-type="removed">
                                        {i18n.t("ui.patch.action.deleted")}
                                      </span>
                                    </Match>
                                    <Match when={file.type === "move"}>
                                      <span data-slot="apply-patch-change" data-type="modified">
                                        {i18n.t("ui.patch.action.moved")}
                                      </span>
                                    </Match>
                                    <Match when={true}>
                                      <DiffChanges changes={{ additions: file.additions, deletions: file.deletions }} />
                                    </Match>
                                  </Switch>
                                  <Icon name="chevron-down" size="small" data-slot="accordion-caret" />
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
                      <TextShimmer text={i18n.t("ui.tool.patch")} active={pending()} />
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
                    <DiffChanges
                      changes={{ additions: single()!.additions, deletions: single()!.deletions }}
                      variant="muted-hover"
                    />
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
                      {i18n.t("ui.patch.action.created")}
                    </span>
                  </Match>
                  <Match when={single()!.type === "delete"}>
                    <span data-slot="apply-patch-change" data-type="removed">
                      {i18n.t("ui.patch.action.deleted")}
                    </span>
                  </Match>
                  <Match when={single()!.type === "move"}>
                    <span data-slot="apply-patch-change" data-type="modified">
                      {i18n.t("ui.patch.action.moved")}
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
    const i18n = useI18n()
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
          title: i18n.t("ui.tool.todos"),
          subtitle: subtitle(),
        }}
      >
        <Show when={todos().length}>
          <div data-component="todos" class="ui-todos">
            <For each={todos()}>
              {(todo: AgentTodo) => (
                <Checkbox readOnly checked={todo.status === "completed"}>
                  <span
                    data-slot="message-part-todo-content" class="ui-message-part-todo-content"
                    data-completed={todo.status === "completed" ? "completed" : undefined}
                  >
                    {todo.content}
                  </span>
                </Checkbox>
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
    const i18n = useI18n()
    // Claude's dynamic-tool lane persists the skill id on `input.skill`; the
    // OpenCode lane uses `input.name`.
    const name = createMemo(() => props.input.name || props.input.skill)
    const title = createMemo(() => name() || i18n.t("ui.tool.skill"))
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

    // A completed skill whose frame carried no output still names its call — the
    // row must open to that rather than swallow the click onto nothing.
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

/**
 * Harness tool-name aliases. The registry above uses OpenCode's vocabulary, but Claxedo
 * also drives Codex, which names its shell tool `command` (input `{command, kind}`).
 * Unaliased names fall through to `GenericTool` — an "Called `command`" row with a raw
 * key=value arg dump, an MCP icon, and no children (so it can't even expand). Aliasing
 * maps them onto the real renderer so they get the right icon/verb, an expandable output
 * pane, and — because the grouping pass keys off these names — they fold into work groups.
 * Registered after the definitions above so the targets exist.
 */
for (const [alias, target] of toolNameAliases()) {
  if (ToolRegistry.render(alias)) continue
  const render = ToolRegistry.render(target)
  if (render) ToolRegistry.register({ name: alias, render })
}
