import {
  children,
  createEffect,
  createMemo,
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
import { useTranscriptI18n, type TranscriptI18n, type TranscriptTextKey } from "./i18n"
import { createStore } from "solid-js/store"
import { Collapsible, Icon, type IconProps, TextShimmer } from "@/ui"
import { useSecondClock } from "@/lib/clock"
import { formatDuration } from "./format-duration"
import { safeLinkHref } from "./safe-link"
import { ScrollableOutput } from "./scrollable-output"

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
  onSubtitleClick?: (event: MouseEvent) => void
  onTriggerClick?: JSX.EventHandlerUnion<HTMLElement, MouseEvent>
  onTriggerKeyDown?: JSX.EventHandlerUnion<HTMLElement, KeyboardEvent>
  triggerHref?: string
  triggerAsLink?: boolean
  clickable?: boolean
  startedAt?: number
}

const SPRING = { type: "spring" as const, visualDuration: 0.35, bounce: 0 }
const deferredMounts: Array<{ active: boolean; fn: () => void }> = []
let deferredFrame: number | undefined

function flushDeferredMounts() {
  while (deferredMounts.length > 0) {
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

export function shellExitCode(metadata: Record<string, unknown> | undefined): number | undefined {
  const code = metadata?.exitCode
  return typeof code === "number" && Number.isFinite(code) ? code : undefined
}

export function ToolExitCode(props: { code: number | undefined }) {
  const i18n = useTranscriptI18n()
  const failed = () => (props.code !== undefined && props.code !== 0 ? props.code : undefined)
  return (
    <Show when={failed()}>
      {(code) => <span data-slot="basic-tool-tool-exit">{i18n.t("transcript.tool.shell.exit", { code: code() })}</span>}
    </Show>
  )
}

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
  const content = children(() => (props.defer && !ready() ? undefined : props.children))
  const hasChildren = () => (props.defer && !ready() ? "children" in props : hasRenderedContent(content()))

  const now = useSecondClock(() => pending() && typeof props.startedAt === "number")
  const elapsed = () =>
    typeof props.startedAt === "number" ? formatDuration(Math.max(0, now() - props.startedAt)) : ""
  const dynamicTrigger = typeof props.trigger === "function" ? props.trigger(open) : undefined
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
    if (props.locked && !value) return
    setOpen(value)
  }

  const triggerHref = () => safeLinkHref(props.triggerHref)

  const trigger = () => (
    <div
      data-component="tool-trigger"
      data-clickable={props.clickable ? "true" : undefined}
      data-hide-details={props.hideDetails ? "true" : undefined}
    >
      <div data-slot="basic-tool-tool-trigger-content">
        <Show when={props.icon}>
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
                            props.onSubtitleClick(e)
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
        when={props.triggerAsLink || triggerHref()}
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
          href={triggerHref()}
          role={!triggerHref() && props.clickable ? "button" : undefined}
          tabIndex={!triggerHref() && props.clickable ? 0 : undefined}
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

function args(input: Record<string, unknown> | undefined, exclude?: string) {
  if (!input) return []
  const skip = new Set([...LABEL_KEYS, "intent", "kind"])
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

function isMcpTool(tool: string, input?: Record<string, unknown>) {
  if (input?.intent === "mcp" || input?.kind === "mcp_tool_call") return true
  return tool.toLowerCase().includes("mcp")
}

const INTENT_ICONS: Record<string, IconProps["name"]> = {
  edit: "pencil-line",
  read: "glasses",
  shell: "terminal",
  search: "magnifying-glass",
  fetch: "magnifying-glass",
  delete: "trash",
  mcp: "mcp",
}

export function genericToolIcon(tool: string, input?: Record<string, unknown>): IconProps["name"] {
  if (input?.kind === "image_view" || tool === "view_image") return "photo"
  if (isMcpTool(tool, input)) return "mcp"
  const intent = input?.intent
  if (typeof intent === "string" && INTENT_ICONS[intent]) return INTENT_ICONS[intent]
  switch (canonicalToolName(tool)) {
    case "read":
      return "glasses"
    case "bash":
      return "terminal"
    case "webfetch":
    case "web_fetch":
      return "magnifying-glass"
    case "websearch":
      return "magnifying-glass"
    default:
      return "wrench"
  }
}

const ACTION_KEYS: Record<string, TranscriptTextKey> = {
  sendmessage: "transcript.basicTool.action.sendMessage",
  toolsearch: "transcript.basicTool.action.searchTools",
  listagents: "transcript.basicTool.action.listAgents",
  enterplanmode: "transcript.basicTool.action.enterPlanMode",
  exitplanmode: "transcript.basicTool.action.proposePlan",
}

const PREPOSITION_TITLE_KEYS: Record<string, TranscriptTextKey> = {
  to: "transcript.basicTool.title.to",
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

function serverLabel(server: string) {
  const parts = words(server).map((word) => (isAcronym(word) ? word : word.toLowerCase()))
  return parts.filter((word, index) => word !== parts[index - 1]).join(" ")
}

function actionPhrase(name: string, hasContext: boolean, i18n: TranscriptI18n) {
  const key = ACTION_KEYS[name.toLowerCase()]
  if (key) return i18n.t(key)
  const parts = words(name)
  if (parts.length === 0 || (parts.length === 1 && !hasContext)) return undefined
  return sentenceCase(parts)
}

export function toolActionPhrase(tool: string, i18n: TranscriptI18n): string | undefined {
  const mcp = mcpName(tool)
  return actionPhrase(mcp?.name ?? tool, mcp !== undefined, i18n)
}

export type GenericToolTitle = {
  title: string
  subtitle?: string
  context?: string
}

export function humanizeTool(
  tool: string,
  input: Record<string, unknown> | undefined,
  i18n: TranscriptI18n,
): GenericToolTitle {
  const object = labelEntry(input)
  const mcp = mcpName(tool)
  const action = toolActionPhrase(tool, i18n)
  if (!action) {
    return {
      title: i18n.t("transcript.basicTool.called", { tool }).replaceAll("`", ""),
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
  revealed?: boolean
  onRevealedChange?: (revealed: boolean) => void
}) {
  const i18n = useTranscriptI18n()
  const title = createMemo(() => humanizeTool(props.tool, props.input, i18n))
  const output = () => (typeof props.output === "string" ? props.output.trim() : "")

  return (
    <div>
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
        {output() ? (
          <ScrollableOutput component="tool-output" revealed={props.revealed} onRevealedChange={props.onRevealedChange}>
            <pre>{output()}</pre>
          </ScrollableOutput>
        ) : undefined}
      </BasicTool>
    </div>
  )
}
