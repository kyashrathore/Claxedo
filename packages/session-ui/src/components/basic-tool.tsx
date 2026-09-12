import {
  children,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  type Accessor,
  type JSX,
  type ResolvedChildren,
} from "solid-js"
import { animate, type AnimationPlaybackControls } from "motion"
import { canonicalToolName } from "@claxedo/agent-runtime-contract"
import { useI18n, type UiI18n } from "@opencode-ai/ui/context/i18n"
import { createStore } from "solid-js/store"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { formatDuration } from "./format-duration"

export type TriggerTitle = {
  title: string
  titleClass?: string
  subtitle?: string
  subtitleClass?: string
  args?: string[]
  argsClass?: string
  action?: JSX.Element
}

const isTriggerTitle = (val: any): val is TriggerTitle => {
  return (
    typeof val === "object" && val !== null && "title" in val && (typeof Node === "undefined" || !(val instanceof Node))
  )
}

export interface BasicToolProps {
  icon: IconProps["name"]
  trigger: TriggerTitle | JSX.Element | ((open: Accessor<boolean>) => JSX.Element)
  children?: JSX.Element
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  forceOpen?: boolean
  defer?: boolean
  locked?: boolean
  animated?: boolean
  onSubtitleClick?: () => void
  onTriggerClick?: JSX.EventHandlerUnion<HTMLElement, MouseEvent>
  onTriggerKeyDown?: JSX.EventHandlerUnion<HTMLElement, KeyboardEvent>
  triggerHref?: string
  triggerAsLink?: boolean
  clickable?: boolean
  /** Epoch ms the tool started running; drives the live "for Xs" elapsed while pending. */
  startedAt?: number
}

const SPRING = { type: "spring" as const, visualDuration: 0.35, bounce: 0 }
const deferredMounts: Array<{ active: boolean; fn: () => void }> = []
let deferredFrame: number | undefined

function flushDeferredMounts() {
  while (deferredMounts.length > 0) {
    // Timeline tools are mounted top-to-bottom, but the viewport starts at the latest turn.
    // Pop from the end so heavy default-open bodies near the bottom become interactive first.
    const item = deferredMounts.pop()!
    if (item.active) {
      deferredFrame = deferredMounts.length > 0 ? requestAnimationFrame(flushDeferredMounts) : undefined
      item.fn()
      return
    }
  }
  deferredFrame = undefined
}

function scheduleDeferredFlush() {
  if (deferredFrame !== undefined) return
  deferredFrame = requestAnimationFrame(() => {
    deferredFrame = requestAnimationFrame(flushDeferredMounts)
  })
}

function scheduleDeferredMount(fn: () => void) {
  const item = { active: true, fn }
  deferredMounts.push(item)
  scheduleDeferredFlush()
  return () => {
    item.active = false
  }
}

function scheduleFrameMount(fn: () => void) {
  const frame = requestAnimationFrame(fn)
  return () => cancelAnimationFrame(frame)
}

/**
 * Whether resolved children amount to anything on screen. A renderer that gates its
 * body on output it never got still passes a child — the `<Show>` itself — and the
 * presence of that child is what used to put a chevron on a row that opens nothing.
 */
export function hasRenderedContent(value: ResolvedChildren): boolean {
  if (Array.isArray(value)) return value.some(hasRenderedContent)
  if (value === null || value === undefined || typeof value === "boolean") return false
  if (typeof value === "string") return value.trim().length > 0
  return true
}

export function BasicTool(props: BasicToolProps) {
  const [state, setState] = createStore({
    open: props.defaultOpen ?? false,
    ready: !props.defer && (props.defaultOpen ?? false),
  })
  const open = () => props.open ?? state.open
  const ready = () => state.ready
  const pending = () => props.status === "pending" || props.status === "running"
  /**
   * Resolved once and reused by the body below, so asking what the row holds does not
   * build it again. A deferred row is not built at all until it is opened — that is the
   * whole point of `defer` — so until then the answer is only whether a child was passed.
   */
  const content = children(() => (props.defer && !ready() ? undefined : props.children))
  const hasChildren = () => (props.defer && !ready() ? "children" in props : hasRenderedContent(content()))

  // Live elapsed: tick once a second only while the tool is running.
  const [nowMs, setNowMs] = createSignal(Date.now())
  createEffect(() => {
    if (!pending() || typeof props.startedAt !== "number") return
    setNowMs(Date.now())
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    onCleanup(() => clearInterval(id))
  })
  const elapsed = () =>
    typeof props.startedAt === "number" ? formatDuration(Math.max(0, nowMs() - props.startedAt)) : ""
  const dynamicTrigger = typeof props.trigger === "function" ? props.trigger(open) : undefined
  /** The trigger when it is neither a render function nor a structured title: plain JSX. */
  const plainTrigger = (): JSX.Element => {
    const value = props.trigger
    if (typeof value === "function") return undefined
    if (isTriggerTitle(value)) return undefined
    return value
  }

  let cancelReady: (() => void) | undefined

  const cancel = () => {
    cancelReady?.()
    cancelReady = undefined
  }

  const scheduleReady = (initial = false) => {
    cancel()
    cancelReady = (initial ? scheduleDeferredMount : scheduleFrameMount)(() => {
      cancelReady = undefined
      if (!open()) return
      setState("ready", true)
    })
  }

  onCleanup(cancel)

  onMount(() => {
    if (props.defer && open()) scheduleReady(true)
  })

  const setOpen = (value: boolean) => {
    if (props.open === undefined) setState("open", value)
    props.onOpenChange?.(value)
  }

  createEffect(() => {
    if (!props.forceOpen) return
    if (open()) return
    setOpen(true)
  })

  createEffect(
    on(
      open,
      (value) => {
        if (!props.defer) return
        if (!value) {
          cancel()
          setState("ready", false)
          return
        }

        scheduleReady()
      },
      { defer: true },
    ),
  )

  // Animated height for collapsible open/close
  let contentRef: HTMLDivElement | undefined
  let heightAnim: AnimationPlaybackControls | undefined
  const initialOpen = open()

  createEffect(
    on(
      open,
      (isOpen) => {
        if (!props.animated || !contentRef) return
        heightAnim?.stop()
        if (isOpen) {
          contentRef.style.overflow = "hidden"
          heightAnim = animate(contentRef, { height: "auto" }, SPRING)
          void heightAnim.finished.then(() => {
            if (!contentRef || !open()) return
            contentRef.style.overflow = "visible"
            contentRef.style.height = "auto"
          })
        } else {
          contentRef.style.overflow = "hidden"
          heightAnim = animate(contentRef, { height: "0px" }, SPRING)
        }
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    heightAnim?.stop()
  })

  /**
   * A running tool is the one a reader most wants to open — streaming output is the
   * only thing that says how far along a long call is — so `pending` does not gate
   * this. `hasChildren` already withholds the affordance until there is something
   * to show.
   */
  const handleOpenChange = (value: boolean) => {
    if (props.locked && !value) return
    setOpen(value)
  }

  const trigger = () => (
    <div
      data-component="tool-trigger"
      data-clickable={props.clickable ? "true" : undefined}
      data-hide-details={props.hideDetails ? "true" : undefined}
    >
      <div data-slot="basic-tool-tool-trigger-content">
        <Show when={props.icon && !props.hideDetails}>
          <span data-slot="basic-tool-tool-leading-icon" class="ui-basic-tool-tool-leading-icon">
            <Icon name={props.icon} size="small" />
          </span>
        </Show>
        <div data-slot="basic-tool-tool-info">
          <Switch>
            <Match when={dynamicTrigger !== undefined}>{dynamicTrigger}</Match>
            <Match when={isTriggerTitle(props.trigger) && props.trigger}>
              {(title) => (
                <div data-slot="basic-tool-tool-info-structured">
                  <div data-slot="basic-tool-tool-info-main">
                    <span
                      data-slot="basic-tool-tool-title"
                      classList={{
                        [title().titleClass ?? ""]: !!title().titleClass,
                      }}
                    >
                      <TextShimmer text={title().title} active={pending()} />
                    </span>
                    {/* The subtitle and args are what name the call — the file being read,
                        the pattern being searched. Withholding them until the call finishes
                        leaves a bare verb on screen for exactly as long as the call is
                        interesting, so they show as soon as the input names them. */}
                    <Show when={title().subtitle}>
                      <span
                        data-slot="basic-tool-tool-subtitle"
                        title={title().subtitle}
                        classList={{
                          [title().subtitleClass ?? ""]: !!title().subtitleClass,
                          clickable: !!props.onSubtitleClick,
                        }}
                        onClick={(e) => {
                          if (props.onSubtitleClick) {
                            e.stopPropagation()
                            props.onSubtitleClick()
                          }
                        }}
                      >
                        {title().subtitle}
                      </span>
                    </Show>
                    <Show when={title().args?.length}>
                      <For each={title().args}>
                        {(arg) => (
                          <span
                            data-slot="basic-tool-tool-arg"
                            classList={{
                              "ui-basic-tool-tool-arg": true,
                              [title().argsClass ?? ""]: !!title().argsClass,
                            }}
                          >
                            {arg}
                          </span>
                        )}
                      </For>
                    </Show>
                  </div>
                  <Show when={!pending() && title().action}>
                    <span data-slot="basic-tool-tool-action">{title().action}</span>
                  </Show>
                </div>
              )}
            </Match>
            <Match when={true}>{plainTrigger()}</Match>
          </Switch>
        </div>
      </div>
      <Show when={pending() && typeof props.startedAt === "number"}>
        <span data-slot="basic-tool-tool-elapsed">{elapsed()}</span>
      </Show>
      <Show when={hasChildren() && !props.hideDetails && !props.locked}>
        <Collapsible.Arrow />
      </Show>
    </div>
  )

  return (
    <Collapsible open={open()} onOpenChange={handleOpenChange} class="tool-collapsible">
      <Show
        when={props.triggerAsLink || props.triggerHref}
        fallback={
          <Collapsible.Trigger
            data-hide-details={props.hideDetails ? "true" : undefined}
            onClick={props.onTriggerClick}
          >
            {trigger()}
          </Collapsible.Trigger>
        }
      >
        <Collapsible.Trigger
          as="a"
          href={props.triggerHref}
          role={!props.triggerHref && props.clickable ? "button" : undefined}
          tabIndex={!props.triggerHref && props.clickable ? 0 : undefined}
          data-hide-details={props.hideDetails ? "true" : undefined}
          onClick={props.onTriggerClick}
          onKeyDown={props.onTriggerKeyDown}
        >
          {trigger()}
        </Collapsible.Trigger>
      </Show>
      <Show when={props.animated && hasChildren() && !props.hideDetails}>
        <div
          ref={contentRef}
          data-slot="collapsible-content"
          data-animated
          style={{
            height: initialOpen ? "auto" : "0px",
            overflow: initialOpen ? "visible" : "hidden",
          }}
        >
          {content()}
        </div>
      </Show>
      <Show when={!props.animated && hasChildren() && !props.hideDetails}>
        <Collapsible.Content>
          {content()}
        </Collapsible.Content>
      </Show>
    </Collapsible>
  )
}

const LABEL_KEYS = ["description", "query", "url", "filePath", "path", "pattern", "name", "command", "to"]

/** The input a tool row is about, and the key it came from — the key can carry a preposition. */
/**
 * Collapses a JSON payload embedded in a subtitle to `{…}`.
 *
 * A tool argument often carries a whole request body (`call generate-app-url {"url":
 * "/data-management/events", "params": {}}`). The subtitle is a single clipped line, so
 * the payload arrives shredded mid-token and reads as noise; the body renders it in full.
 * Only balanced runs are collapsed, so a lone brace in prose survives untouched.
 */
export function collapsePayload(value: string) {
  let out = ""
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === "{" || char === "[") {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (char !== "}" && char !== "]") {
      if (depth === 0) out += char
      continue
    }
    if (depth === 0) {
      out += char
      continue
    }
    depth--
    if (depth === 0) out += value.slice(start, start + 1) === "{" ? "{…}" : "[…]"
  }
  return depth === 0 ? out.replace(/\s+/g, " ").trim() : value
}

function labelEntry(input: Record<string, unknown> | undefined) {
  for (const key of LABEL_KEYS) {
    const value = input?.[key]
    if (typeof value === "string" && value.length > 0) return { key, value }
  }
  return undefined
}

/**
 * Arg chips for tools with no registered renderer. Short scalars only: a long string (a
 * shell command, a patch body) is already the row's subtitle, and repeating it at row
 * width makes the row unreadable.
 */
function args(input: Record<string, unknown> | undefined, exclude?: string) {
  if (!input) return []
  const skip = new Set(LABEL_KEYS)
  return Object.entries(input)
    .filter(([key]) => !skip.has(key))
    .flatMap(([key, value]) => {
      if (typeof value === "string") {
        if (!value || value === exclude || value.length > 40) return []
        return [`${key}=${value}`]
      }
      if (typeof value === "number") return [`${key}=${value}`]
      if (typeof value === "boolean") return [`${key}=${value}`]
      return []
    })
    .slice(0, 3)
}

/**
 * Whether a tool row is an MCP operation, for any harness.
 *
 * `intent` and `kind` are the harness-agnostic signals: every adapter routes
 * through `canonicalToolIntent`, and the opencode-compat projection copies both
 * onto the part input, so codex (`item/mcpToolCall/*`), cursor (`mcp*` names)
 * and claude (`mcp__server__tool`) all arrive here already classified. The name
 * check is the backstop, and it is a substring rather than the `mcp__` prefix
 * because the MCP *resource* tools carry no prefix and are named differently per
 * harness — `ListMcpResourcesTool` on claude, `list_mcp_resources` on opencode.
 */
function isMcpTool(tool: string, input?: Record<string, unknown>) {
  if (input?.intent === "mcp" || input?.kind === "mcp_tool_call") return true
  return tool.toLowerCase().includes("mcp")
}

/**
 * Icon by canonical tool intent — the only classification every harness shares.
 *
 * Tool *names* agree on nothing. Take a file edit: opencode calls it `edit` /
 * `write` / `apply_patch`, claude `Edit` / `Write` / `MultiEdit`, cursor `write`
 * / `edit`, codex synthesises the literal string `file-change`, and an ACP client
 * sends whatever it likes. Every one of those lands on `intent: "edit"` — claude,
 * codex and cursor via a `file_change` kind through `canonicalToolIntent`, ACP via
 * its own `kind === "edit"` rule in `harnesses/acp/state.ts`. The projection copies
 * `intent` onto the part input, so keying on it here covers all five at once where
 * a name switch covers one harness per case.
 *
 * Intents absent from this table (`list`, `move`, `lint`, `computer`, …) have no
 * settled mark yet and fall through to the wrench rather than borrowing a wrong one.
 */
const INTENT_ICONS: Record<string, IconProps["name"]> = {
  edit: "pencil-line",
  read: "glasses",
  shell: "terminal",
  search: "magnifying-glass",
  fetch: "window-cursor",
  delete: "trash",
  mcp: "mcp",
}

export function genericToolIcon(tool: string, input?: Record<string, unknown>): IconProps["name"] {
  if (isMcpTool(tool, input)) return "mcp"
  const intent = input?.intent
  if (typeof intent === "string" && INTENT_ICONS[intent]) return INTENT_ICONS[intent]
  // Name fallbacks, for parts that reach the timeline without a classified
  // intent — the opencode native engine emits tool names with no ToolDisplay.
  switch (canonicalToolName(tool)) {
    case "read":
      return "glasses"
    case "bash":
      return "terminal"
    case "webfetch":
    // `web_fetch` has no alias: no harness that sends it also sends `webfetch`.
    case "web_fetch":
      return "window-cursor"
    case "websearch":
      return "magnifying-glass"
    default:
      // A wrench, not `mcp`: the fallback covers every unrecognised tool, and
      // most of them are not MCP tools at all.
      return "wrench"
  }
}

/**
 * Tool names that reach the timeline as one lowercased token (`SendMessage` arrives as
 * `sendmessage`), so no splitter can recover the words. Every other name is split
 * mechanically; this table exists only where that recovery is impossible.
 */
const ACTION_KEYS: Record<string, string> = {
  sendmessage: "ui.basicTool.action.sendMessage",
  toolsearch: "ui.basicTool.action.searchTools",
  listagents: "ui.basicTool.action.listAgents",
}

/** Input keys that are themselves the preposition joining the action to its object. */
const PREPOSITION_TITLE_KEYS: Record<string, string> = {
  to: "ui.basicTool.title.to",
}

function mcpName(tool: string) {
  const parts = tool.split("__")
  if (parts.length < 3 || parts[0] !== "mcp" || !parts[1]) return undefined
  const name = parts.slice(2).join("__")
  if (!name) return undefined
  return { server: parts[1], name }
}

function words(identifier: string) {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter((word) => word.length > 0)
}

const isAcronym = (word: string) => word.length > 1 && word === word.toUpperCase()

function sentenceCase(parts: string[]) {
  return parts
    .map((word, index) => {
      if (isAcronym(word)) return word
      const lower = word.toLowerCase()
      return index === 0 ? lower[0].toUpperCase() + lower.slice(1) : lower
    })
    .join(" ")
}

/**
 * `plugin_posthog_posthog` is a plugin name followed by the server it ships; when the two
 * repeat, one word is the whole context.
 */
function serverLabel(server: string) {
  const parts = words(server).map((word) => (isAcronym(word) ? word : word.toLowerCase()))
  return parts.filter((word, index) => word !== parts[index - 1]).join(" ")
}

/**
 * A single word says nothing the raw name did not, so it becomes a title only for an MCP
 * name, which arrives with a server to carry the missing context.
 */
function actionPhrase(name: string, hasContext: boolean, i18n: UiI18n) {
  const key = ACTION_KEYS[name.toLowerCase()]
  if (key) return i18n.t(key)
  const parts = words(name)
  if (parts.length === 0 || (parts.length === 1 && !hasContext)) return undefined
  return sentenceCase(parts)
}

/**
 * The action a tool name reads as, or nothing when the name yields none — a caller with
 * its own fallback needs to know which it got, where `humanizeTool` has already chosen.
 */
export function toolActionPhrase(tool: string, i18n: UiI18n): string | undefined {
  const mcp = mcpName(tool)
  return actionPhrase(mcp?.name ?? tool, mcp !== undefined, i18n)
}

export type GenericToolTitle = {
  title: string
  subtitle?: string
  /** The MCP server, shown beside the row as secondary context. */
  context?: string
}

/**
 * A tool row with no registered renderer, read as a sentence: the action from the tool
 * name, the object from the input. A name that yields neither falls back to the raw call.
 */
export function humanizeTool(
  tool: string,
  input: Record<string, unknown> | undefined,
  i18n: UiI18n,
): GenericToolTitle {
  const object = labelEntry(input)
  const mcp = mcpName(tool)
  const action = toolActionPhrase(tool, i18n)
  if (!action) {
    return {
      title: i18n.t("ui.basicTool.called", { tool }).replaceAll("`", ""),
      subtitle: object ? collapsePayload(object.value) : undefined,
    }
  }
  const prepositionKey = object ? PREPOSITION_TITLE_KEYS[object.key] : undefined
  return {
    title: prepositionKey ? i18n.t(prepositionKey, { action }) : action,
    subtitle: object ? collapsePayload(object.value) : undefined,
    context: mcp ? serverLabel(mcp.server) : undefined,
  }
}

export function GenericTool(props: {
  tool: string
  status?: string
  hideDetails?: boolean
  input?: Record<string, unknown>
  output?: string
  startedAt?: number
}) {
  const i18n = useI18n()
  const title = createMemo(() => humanizeTool(props.tool, props.input, i18n))
  const output = () => (typeof props.output === "string" ? props.output.trim() : "")

  return (
    <BasicTool
      icon={genericToolIcon(props.tool, props.input)}
      status={props.status}
      startedAt={props.startedAt}
      trigger={{
        title: title().title,
        subtitle: title().subtitle,
        args: [...(title().context ? [title().context!] : []), ...args(props.input, title().subtitle)],
      }}
      hideDetails={props.hideDetails}
    >
      {/* Only pass children when there is output, so BasicTool's chevron stays hidden
          (and the row stays non-interactive) for tools that produced nothing. */}
      {output() ? (
        <div data-component="tool-output" data-scrollable tabIndex={0} role="region">
          <pre>{output()}</pre>
        </div>
      ) : undefined}
    </BasicTool>
  )
}
