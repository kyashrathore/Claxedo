import {
  createEffect,
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
} from "solid-js"
import { animate, type AnimationPlaybackControls } from "motion"
import { useI18n } from "@opencode-ai/ui/context/i18n"
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
  /** Epoch ms the tool started running; drives the live "for Xs" elapsed while pending (T6). */
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

export function BasicTool(props: BasicToolProps) {
  const [state, setState] = createStore({
    open: props.defaultOpen ?? false,
    ready: !props.defer && (props.defaultOpen ?? false),
  })
  const open = () => props.open ?? state.open
  const ready = () => state.ready
  const pending = () => props.status === "pending" || props.status === "running"
  const hasChildren = () => (props.defer ? "children" in props : props.children)

  // Live elapsed (T6): tick once a second only while the tool is running.
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

  const handleOpenChange = (value: boolean) => {
    if (pending()) return
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
                    <Show when={!pending()}>
                      <Show when={title().subtitle}>
                        <span
                          data-slot="basic-tool-tool-subtitle"
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
                    </Show>
                  </div>
                  <Show when={!pending() && title().action}>
                    <span data-slot="basic-tool-tool-action">{title().action}</span>
                  </Show>
                </div>
              )}
            </Match>
            <Match when={true}>{props.trigger as JSX.Element}</Match>
          </Switch>
        </div>
      </div>
      <Show when={pending() && typeof props.startedAt === "number"}>
        <span data-slot="basic-tool-tool-elapsed">{elapsed()}</span>
      </Show>
      <Show when={hasChildren() && !props.hideDetails && !props.locked && !pending()}>
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
          <Show when={!props.defer || ready()}>{props.children}</Show>
        </div>
      </Show>
      <Show when={!props.animated && hasChildren() && !props.hideDetails}>
        <Collapsible.Content>
          <Show when={!props.defer || ready()}>{props.children}</Show>
        </Collapsible.Content>
      </Show>
    </Collapsible>
  )
}

const LABEL_KEYS = ["description", "query", "url", "filePath", "path", "pattern", "name", "command"]

function label(input: Record<string, unknown> | undefined) {
  return LABEL_KEYS.map((key) => input?.[key]).find(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
}

/**
 * Arg chips for tools with no registered renderer. Keep them to short scalars: a long
 * string (a shell command, a patch body) is already the row's subtitle or is simply noise
 * at row width, and repeating the subtitle verbatim is what made these rows unreadable.
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
  shell: "terminal-square",
  search: "magnifying-glass",
  fetch: "window-cursor",
  delete: "trash",
  mcp: "mcp",
}

function genericToolIcon(tool: string, input?: Record<string, unknown>): IconProps["name"] {
  if (isMcpTool(tool, input)) return "mcp"
  const intent = input?.intent
  if (typeof intent === "string" && INTENT_ICONS[intent]) return INTENT_ICONS[intent]
  // Name fallbacks, for parts that reach the timeline without a classified
  // intent — the opencode native engine emits tool names with no ToolDisplay.
  switch (tool.toLowerCase()) {
    case "read":
    case "read_file":
      return "glasses"
    case "bash":
    case "command":
    case "shell":
    case "local_shell":
      return "terminal-square"
    case "webfetch":
    case "web_fetch":
      return "window-cursor"
    case "websearch":
    case "web_search":
      return "magnifying-glass"
    default:
      // A wrench, not `mcp`: the fallback covers every unrecognised tool, and
      // most of them are not MCP tools at all.
      return "wrench"
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
  const subtitle = () => label(props.input)
  const output = () => (typeof props.output === "string" ? props.output.trim() : "")

  return (
    <BasicTool
      icon={genericToolIcon(props.tool, props.input)}
      status={props.status}
      startedAt={props.startedAt}
      trigger={{
        title: i18n.t("ui.basicTool.called", { tool: props.tool }).replaceAll("`", ""),
        subtitle: subtitle(),
        args: args(props.input, subtitle()),
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
