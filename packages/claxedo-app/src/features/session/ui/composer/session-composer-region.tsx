import { Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { useLayout } from "@/features/session/app-ports"
import { PromptInput } from "@/features/session/composer/composer"
import { useLanguage } from "@/platform/i18n/provider"
import { usePrompt } from "@/features/session/providers/prompt"
import { getSessionHandoff, setSessionHandoff } from "../prompt-preview-handoff"
import { previewPromptText } from "../prompt-preview"
import { useSessionKey } from "@/features/session/session-layout"
import { SessionPermissionDock } from "./session-permission-dock"
import { SessionQuestionDock } from "./session-question-dock"
import { SessionFollowupDock } from "./session-followup-dock"
import { SessionRevertDock } from "./session-revert-dock"
import type { SessionComposerState } from "./session-composer-state"
import { SessionTodoDock } from "./session-todo-dock"
import type { FollowupDraft } from "@/features/session/composer/ui/submit"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { directorySessions } from "@/features/session/data/sync/directory-session-cache"
import type { SessionRef } from "@/platform/identity/session-ref"
import type { ComposerMode } from "@/features/session/composer/mode"
import { usePromptHarnessControllersOptional } from "@/features/session/composer/ui/harness-controller"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

export function SessionComposerRegion(props: {
  state: SessionComposerState
  ready: boolean
  centered: boolean
  placement?: "dock" | "inline"
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeChange?: (worktree: string) => void
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  onResponseSubmit: () => void
  followup?: {
    queue: () => boolean
    items: { id: string; text: string }[]
    sending?: string
    edit?: { id: string; prompt: FollowupDraft["prompt"]; context: FollowupDraft["context"] }
    onQueue: (draft: FollowupDraft) => void
    onAbort: () => void
    onSend: (id: string) => void
    onEdit: (id: string) => void
    onEditLoaded: () => void
  }
  revert?: {
    items: { id: string; text: string }[]
    restoring?: string
    disabled?: boolean
    onRestore: (id: string) => void
  }
  setPromptDockRef: (el: HTMLDivElement) => void
  visualDuration?: number
  bounce?: number
  dockOpenVisualDuration?: number
  dockOpenBounce?: number
  dockCloseVisualDuration?: number
  dockCloseBounce?: number
  drawerExpandVisualDuration?: number
  drawerExpandBounce?: number
  drawerCollapseVisualDuration?: number
  drawerCollapseBounce?: number
  subtitleDuration?: number
  subtitleTravel?: number
  subtitleEdge?: number
  countDuration?: number
  countMask?: number
  countMaskHeight?: number
  countWidthDuration?: number
  sessionID?: string
  sessionDirectory?: string
  mode: ComposerMode
  sessionRef?: () => SessionRef | undefined
  signedControlPlane?: () => boolean
  workspaceId?: () => string | undefined
  workspaceKind?: () => "cloud" | "user-hosted" | undefined
  navigateOnCreate?: boolean
  system?: string
  agent?: string
  canAbort?: () => boolean
  /**
   * Session status/active-turn supplied by the session owner (`sessionController`).
   * Without these the composer's `working()`/`busy()` derivation
   * (`session/composer/composer.tsx:324-328`) falls back to its
   * "embedded context" default of always-idle, which permanently hides the
   * busy/stop icon and the escalation-ladder status banner for this — the
   * primary — session composer.
   */
  status?: () => SessionStatus
  activeTurn?: () => boolean
}) {
  const navigate = useNavigate()
  const layout = useLayout()
  const prompt = usePrompt()
  const language = useLanguage()
  const promptHarnessControllers = usePromptHarnessControllersOptional()
  const route = useSessionKey()
  const view = layout.view(route.sessionKey)

  const sessionID = createMemo(() => props.sessionID ?? route.params.id)
  const sessionDirectory = createMemo(() => props.sessionDirectory ?? route.directory())
  const sessionKey = createMemo(() => {
    const id = sessionID()
    return `${sessionDirectory() ?? ""}${id ? "/" + id : ""}`
  })
  const handoffPrompt = createMemo(() => getSessionHandoff(sessionKey())?.prompt)
  const info = createMemo(() => directorySessions(sessionDirectory()).find((session) => session.id === sessionID()))
  const parentID = createMemo(() => info()?.parentID)
  const child = createMemo(() => !!parentID())
  const showComposer = createMemo(() => !props.state.blocked() || child())

  createEffect(() => {
    if (!prompt.ready()) return
    setSessionHandoff(sessionKey(), { prompt: previewPromptText(prompt.current()) })
  })

  const [store, setStore] = createStore({
    ready: false,
    height: 320,
    body: undefined as HTMLDivElement | undefined,
  })
  let timer: number | undefined
  let frame: number | undefined

  const clear = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
      frame = undefined
    }
  }

  createEffect(() => {
    route.sessionKey()
    const ready = props.ready
    const delay = 140

    clear()
    setStore("ready", false)
    if (!ready) return

    frame = requestAnimationFrame(() => {
      frame = undefined
      timer = window.setTimeout(() => {
        setStore("ready", true)
        timer = undefined
      }, delay)
    })
  })

  onCleanup(clear)

  const open = createMemo(() => store.ready && props.state.dock() && !props.state.closing())
  const progress = useSpring(() => (open() ? 1 : 0), { visualDuration: 0.3, bounce: 0 })
  const value = createMemo(() => {
    const next = Math.max(0, Math.min(1, progress()))
    if (next > 0.995) return 1
    if (next < 0.005) return 0
    return next
  })
  const dock = createMemo(() => (store.ready && props.state.dock()) || value() > 0.001)
  const rolled = createMemo(() => (props.revert?.items.length ? props.revert : undefined))
  const lift = createMemo(() => (rolled() ? 18 : 36 * value()))
  const full = createMemo(() => Math.max(78, store.height))

  const openParent = () => {
    const id = parentID()
    if (!id) return
    navigate(route.sessionHref(id))
  }

  createEffect(() => {
    const el = store.body
    if (!el) return
    const update = () => setStore("height", el.getBoundingClientRect().height)
    createResizeObserver(store.body, update)
    update()
  })

  return (
    <div
      ref={props.setPromptDockRef}
      data-component="session-prompt-dock"
      classList={{
        "w-full flex flex-col justify-center items-center pointer-events-none": true,
        "shrink-0 pb-3 bg-background-stronger": props.placement !== "inline",
      }}
    >
      <div
        classList={{
          "w-full px-3 pointer-events-auto": true,
          "max-w-[720px] px-0": props.placement === "inline",
          "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
        }}
      >
        <Show when={props.state.questionRequest()} keyed>
          {(request) => (
            <div>
              <SessionQuestionDock request={request} onSubmit={props.onResponseSubmit} />
            </div>
          )}
        </Show>

        <Show when={props.state.permissionRequest()} keyed>
          {(request) => (
            <div>
              <SessionPermissionDock
                request={request}
                responding={props.state.permissionResponding()}
                onDecide={(response) => {
                  props.onResponseSubmit()
                  props.state.decide(response)
                }}
              />
            </div>
          )}
        </Show>

        <Show when={showComposer()}>
          <Show
            when={prompt.ready()}
            fallback={
              <>
                <Show when={rolled()} keyed>
                  {(revert) => (
                    <div class="pb-2">
                      <SessionRevertDock
                        items={revert.items}
                        restoring={revert.restoring}
                        disabled={revert.disabled}
                        onRestore={revert.onRestore}
                      />
                    </div>
                  )}
                </Show>
                <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none">
                  {handoffPrompt() || language.t("prompt.loading")}
                </div>
              </>
            }
          >
            <Show when={dock()}>
              <div
                classList={{
                  "overflow-hidden": true,
                  "pointer-events-none": value() < 0.98,
                }}
                style={{
                  "max-height": `${full() * value()}px`,
                }}
              >
                <div ref={(el) => setStore("body", el)}>
                  <SessionTodoDock
                    sessionID={route.params.id}
                    todos={props.state.todos()}
                    collapsed={view.todoCollapsed.get()}
                    onToggle={() => view.todoCollapsed.set(!view.todoCollapsed.get())}
                    collapseLabel={language.t("session.todo.collapse")}
                    expandLabel={language.t("session.todo.expand")}
                    dockProgress={value()}
                  />
                </div>
              </div>
            </Show>
            <Show when={rolled()} keyed>
              {(revert) => (
                <div
                  style={{
                    "margin-top": `${-36 * value()}px`,
                  }}
                >
                  <SessionRevertDock
                    items={revert.items}
                    restoring={revert.restoring}
                    disabled={revert.disabled}
                    onRestore={revert.onRestore}
                  />
                </div>
              )}
            </Show>
            <div
              classList={{
                "relative z-10": true,
              }}
              style={{
                "margin-top": `${-lift()}px`,
              }}
            >
              <Show when={props.followup?.items.length}>
                <SessionFollowupDock
                  items={props.followup!.items}
                  sending={props.followup!.sending}
                  onSend={props.followup!.onSend}
                  onEdit={props.followup!.onEdit}
                />
              </Show>
              <Show
                when={child()}
                fallback={
                  <Show when={!props.state.blocked()}>
                    <PromptInput
                      mode={props.mode}
                      harnessSubmitController={promptHarnessControllers.submit}
                      harnessSelectionController={promptHarnessControllers.selection}
                      variant={props.placement === "inline" ? "new-session" : undefined}
                      ref={props.inputRef}
                      newSessionWorktree={props.newSessionWorktree}
                      onNewSessionWorktreeChange={props.onNewSessionWorktreeChange}
                      onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
                      edit={props.followup?.edit}
                      onEditLoaded={props.followup?.onEditLoaded}
                      shouldQueue={props.followup?.queue}
                      onQueue={props.followup?.onQueue}
                      onAbort={props.followup?.onAbort}
                      onSubmit={props.onSubmit}
                      sessionID={props.sessionID}
                      sessionDirectory={sessionDirectory()}
                      sessionRef={props.sessionRef}
                      signedControlPlane={props.signedControlPlane}
                      workspaceId={props.workspaceId}
                      workspaceKind={props.workspaceKind}
                      navigateOnCreate={props.navigateOnCreate}
                      system={props.system}
                      agent={props.agent}
                      canAbort={props.canAbort}
                      status={props.status}
                      activeTurn={props.activeTurn}
                    />
                  </Show>
                }
              >
                <div
                  ref={props.inputRef}
                  class="w-full rounded-[12px] border border-border-weak-base bg-background-base p-3 text-16-regular text-text-weak"
                >
                  <span>{language.t("session.child.promptDisabled")} </span>
                  <Show when={parentID()}>
                    <button
                      type="button"
                      class="text-text-base transition-colors hover:text-text-strong"
                      onClick={openParent}
                    >
                      {language.t("session.child.backToParent")}
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
