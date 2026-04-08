import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, type JSX } from "solid-js"
import type { QuestionRequest, Todo } from "@opencode-ai/sdk/v2"
import type { OutputFormat } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { BasicTool } from "@opencode-ai/ui/basic-tool"
import { PromptInput } from "@/components/prompt-input"
import { SessionQuestionDock as QuestionDock } from "@/pages/session/composer/session-question-dock"
import { todoState } from "@/pages/session/composer/session-composer-state"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"

interface CompactPromptDockProps {
  title?: string
  onToggle?: () => void
  showToggle?: boolean
  dockPosition?: "left" | "center" | "right"
  onDockPositionChange?: (position: "left" | "center" | "right") => void
  t: (key: string, vars?: Record<string, string | number | boolean>) => string
  questionRequest: () => QuestionRequest | undefined
  permissionRequest: () => { patterns: string[]; permission: string } | undefined
  blocked: boolean
  todos?: Todo[]
  live?: boolean
  onTodosClear?: () => void
  promptReady: boolean
  handoffPrompt?: string
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  setPromptDockRef: (el: HTMLDivElement) => void
  messages?: JSX.Element
  interactiveSlot?: JSX.Element
  sessionID?: string
  sessionDirectory?: string
  navigateOnCreate?: boolean
  dockMode?: "floating" | "side"
  system?: string
  agent?: string
  format?: OutputFormat
  hasMessages?: boolean
  /** Custom empty state shown when there are no messages. Hidden once messages exist. */
  emptyState?: JSX.Element
}

export function CompactPromptDock(props: CompactPromptDockProps) {
  const todos = () => props.todos ?? []
  const live = () => props.live ?? true
  const dockMode = () => props.dockMode ?? "floating"
  const side = () => dockMode() === "side"
  const patterns = () => {
    const perm = props.permissionRequest()
    return Array.isArray(perm?.patterns) ? perm.patterns : []
  }
  const [expanded, setExpanded] = createSignal(false)
  const [todoDock, setTodoDock] = createSignal(todos().length > 0 && live())
  const [todoClosing, setTodoClosing] = createSignal(false)
  const [todoOpening, setTodoOpening] = createSignal(false)
  let todoTimer: number | undefined
  let todoRaf: number | undefined

  const todoDone = createMemo(
    () =>
      todos().length > 0 && todos().every((todo) => todo.status === "completed" || todo.status === "cancelled"),
  )

  const scheduleTodoClose = () => {
    if (todoTimer) window.clearTimeout(todoTimer)
    todoTimer = window.setTimeout(() => {
      setTodoDock(false)
      setTodoClosing(false)
      todoTimer = undefined
    }, 400)
  }

  createEffect(
    on(
      () => [todos().length, todoDone(), live()] as const,
      ([count, complete, active]) => {
        if (todoRaf) cancelAnimationFrame(todoRaf)
        todoRaf = undefined

        const next = todoState({
          count,
          done: complete,
          live: active,
        })

        if (next === "hide") {
          if (todoTimer) window.clearTimeout(todoTimer)
          todoTimer = undefined
          setTodoDock(false)
          setTodoClosing(false)
          setTodoOpening(false)
          return
        }

        if (next === "clear") {
          if (todoTimer) window.clearTimeout(todoTimer)
          todoTimer = undefined
          setTodoDock(false)
          setTodoClosing(false)
          setTodoOpening(false)
          props.onTodosClear?.()
          return
        }

        if (next === "open") {
          if (todoTimer) window.clearTimeout(todoTimer)
          todoTimer = undefined
          const wasHidden = !todoDock() || todoClosing()
          setTodoDock(true)
          setTodoClosing(false)
          if (wasHidden) {
            setTodoOpening(true)
            todoRaf = requestAnimationFrame(() => {
              setTodoOpening(false)
              todoRaf = undefined
            })
            return
          }
          setTodoOpening(false)
          return
        }

        setTodoDock(true)
        setTodoOpening(false)
        setTodoClosing(true)
        if (!todoTimer) scheduleTodoClose()
      },
    ),
  )

  onCleanup(() => {
    if (todoTimer) window.clearTimeout(todoTimer)
  })
  onCleanup(() => {
    if (todoRaf) cancelAnimationFrame(todoRaf)
  })

  let messagesRef!: HTMLDivElement

  const scrollToBottom = () => {
    if (messagesRef) messagesRef.scrollTop = messagesRef.scrollHeight
  }

  // Auto-scroll on expand and when content changes
  createEffect(() => {
    if (!expanded() && !side()) return
    // Scroll to bottom when expanded opens
    requestAnimationFrame(scrollToBottom)

    // Watch for new content (messages rendering)
    const observer = new MutationObserver(scrollToBottom)
    if (messagesRef) observer.observe(messagesRef, { childList: true, subtree: true })
    onCleanup(() => observer.disconnect())
  })

  const controls = () => (
    <Show when={props.onDockPositionChange}>
      <div class="flex items-center gap-0.5">
        <IconButton
          variant={props.dockPosition === "left" ? "secondary" : "ghost"}
          size="small"
          icon="arrow-left"
          onClick={() => props.onDockPositionChange?.("left")}
          aria-label="Dock left"
        />
        <IconButton
          variant={props.dockPosition === "center" ? "secondary" : "ghost"}
          size="small"
          icon="layout-bottom"
          onClick={() => props.onDockPositionChange?.("center")}
          aria-label="Dock center"
        />
        <IconButton
          variant={props.dockPosition === "right" ? "secondary" : "ghost"}
          size="small"
          icon="arrow-right"
          onClick={() => props.onDockPositionChange?.("right")}
          aria-label="Dock right"
        />
      </div>
    </Show>
  )

  const promptRegion = (floating: boolean) => (
    <div>
      <Show when={props.questionRequest()} keyed>
        {(req) => (
          <div data-question="true">
            <QuestionDock request={req} onSubmit={props.onSubmit} />
          </div>
        )}
      </Show>

      <Show when={props.permissionRequest()} keyed>
        {(perm) => (
          <div data-component="tool-part-wrapper" data-permission="true" class="mb-3">
            <BasicTool
              icon="checklist"
              locked
              defaultOpen
              trigger={{
                title: props.t("notification.permission.title"),
                subtitle:
                  perm.permission === "doom_loop"
                    ? props.t("settings.permissions.tool.doom_loop.title")
                    : perm.permission,
              }}
            >
              <Show when={patterns().length > 0}>
                <div class="flex flex-col gap-1 py-2 px-3 max-h-40 overflow-y-auto no-scrollbar">
                  <For each={patterns()}>
                    {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
                  </For>
                </div>
              </Show>
              <Show when={perm.permission === "doom_loop"}>
                <div class="text-12-regular text-text-weak pb-2 px-3">
                  {props.t("settings.permissions.tool.doom_loop.description")}
                </div>
              </Show>
            </BasicTool>
            <div data-component="permission-prompt">
              <div data-slot="permission-actions">
                <Button
                  variant="ghost"
                  size="small"
                  onClick={() => props.onDecide("reject")}
                  disabled={props.responding}
                >
                  {props.t("ui.permission.deny")}
                </Button>
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => props.onDecide("always")}
                  disabled={props.responding}
                >
                  {props.t("ui.permission.allowAlways")}
                </Button>
                <Button
                  variant="primary"
                  size="small"
                  onClick={() => props.onDecide("once")}
                  disabled={props.responding}
                >
                  {props.t("ui.permission.allowOnce")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={!props.blocked}>
        <Show
          when={props.promptReady}
          fallback={
            <div class="w-full min-h-16 border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap">
              {props.handoffPrompt || props.t("prompt.loading")}
            </div>
          }
        >
          <Show when={props.interactiveSlot}>
            {props.interactiveSlot}
          </Show>
          <Show when={todoDock()}>
            <div
              classList={{
                "transition-[max-height,opacity,transform] duration-[400ms] ease-out overflow-hidden": true,
                "max-h-[320px]": !todoClosing(),
                "max-h-0 pointer-events-none": todoClosing(),
                "opacity-0 translate-y-9": todoClosing() || todoOpening(),
                "opacity-100 translate-y-0": !todoClosing() && !todoOpening(),
              }}
            >
              <SessionTodoDock
                todos={todos()}
                collapseLabel={props.t("session.todo.collapse")}
                expandLabel={props.t("session.todo.expand")}
                dockProgress={0}
              />
            </div>
          </Show>
          <div classList={{ "[&_form]:!rounded-t-none": floating && (expanded() || props.hasMessages) }}>
            <PromptInput
              ref={props.inputRef}
              newSessionWorktree={props.newSessionWorktree}
              onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
              onSubmit={props.onSubmit}
              sessionID={props.sessionID}
              navigateOnCreate={props.navigateOnCreate}
              system={props.system}
              agent={props.agent}
            />
          </div>
        </Show>
      </Show>
    </div>
  )

  if (side()) {
    return (
      <div class="relative flex h-full min-h-0 w-full flex-col">
        <Show when={props.onDockPositionChange}>
          <div class="absolute right-2 top-2 z-10 rounded-md border border-border-weak-base bg-background-stronger/90 p-0.5">
            {controls()}
          </div>
        </Show>
        <Show when={props.messages} fallback={
          <Show when={props.emptyState}>
            <div class="flex-1 min-h-0 flex items-center justify-center text-center p-6">
              {props.emptyState}
            </div>
          </Show>
        }>
          <div ref={messagesRef} class="flex-1 min-h-0 overflow-y-auto rounded-[14px] border border-border-base bg-background-base/50">
            {props.messages}
          </div>
        </Show>
        <div
          ref={props.setPromptDockRef}
          data-component="session-prompt-dock"
          class="shrink-0 w-full pt-2 pb-3 flex flex-col justify-center items-center bg-background-stronger pointer-events-none"
        >
          <div class="w-full px-3 pointer-events-auto">{promptRegion(false)}</div>
        </div>
      </div>
    )
  }

  return (
    <div class="flex flex-col items-center w-full max-w-3xl">
      <div
        ref={props.setPromptDockRef}
        classList={{
          "w-full overflow-hidden transition-all duration-200 rounded-[14px] border border-border-base bg-background-stronger": true,
          "max-h-[70vh]": expanded() || !!props.questionRequest() || !!props.permissionRequest(),
          "max-h-48": !expanded() && !props.questionRequest() && !props.permissionRequest(),
        }}
      >
        <Show when={props.hasMessages}>
          <div class="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border-weak-base">
            <div class="text-12-regular text-text-weak truncate">{props.title || props.t("session.title")}</div>
            <div class="flex items-center gap-0.5">
              <div class="mr-1">{controls()}</div>
              <Tooltip value={expanded() ? props.t("common.collapse") : props.t("common.expand")}>
                <IconButton
                  variant="ghost"
                  size="small"
                  icon={expanded() ? "collapse" : "expand"}
                  onClick={() => setExpanded(!expanded())}
                />
              </Tooltip>
              <Show when={props.showToggle ?? true}>
                <Tooltip value={props.t("session.showMessages")}>
                  <IconButton variant="ghost" size="small" icon="layout-right" onClick={() => props.onToggle?.()} />
                </Tooltip>
              </Show>
            </div>
          </div>
        </Show>
        <Show when={expanded() && props.messages}>
          <div ref={messagesRef} class="border-b border-border-base bg-background-base/50 overflow-y-auto max-h-[30vh]">
            {props.messages}
          </div>
        </Show>
        {promptRegion(true)}
      </div>
    </div>
  )
}
