import { Show, createEffect, createMemo, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLayout } from "@/features/session/app-ports"
import { PromptInput } from "@/features/session/composer/composer"
import { useLanguage } from "@/platform/i18n/provider"
import { usePrompt } from "@/features/session/providers/prompt"
import { getSessionHandoff } from "../prompt-preview-handoff"
import { useSessionKey } from "@/features/session/session-layout"
import { SessionPermissionDock } from "./session-permission-dock"
import { SessionQuestionDock } from "./session-question-dock"
import { SessionFollowupDock } from "./session-followup-dock"
import { SessionRevertDock } from "./session-revert-dock"
import type { SessionComposerState } from "./session-composer-state"
import { SessionTodoDock } from "./session-todo-dock"
import type { FollowupDraft } from "@/features/session/composer/ui/submit"
import { directorySessions } from "@/features/session/data/sync/directory-session-cache"
import type { SessionRef } from "@/platform/identity/session-ref"
import type { ComposerMode } from "@/features/session/composer/mode"
import { usePromptHarnessControllersOptional } from "@/features/session/composer/ui/harness-controller"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { PromptRetryAction } from "@/features/session/composer/prompt-input-props"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { AgentRuntimeGoalCapabilities } from "@/platform/runtime/agent/agent-runtime-client"
import { SessionGoalDock } from "./session-goal-dock"

/**
 * The rendered height of the composer container at rest, recorded from the
 * last real mount. The loading placeholder reserves exactly this much space,
 * so the composer replaces it with zero layout shift. Class-derived math
 * (min-heights, paddings) cannot express the composed height — the toolbar
 * row pushes the frame past its min — so the source of truth is one real
 * measurement. Deliberately module-scoped and non-reactive: it only needs to
 * be right for the NEXT placeholder, and it is stable for a given viewport
 * width. Before the first-ever mount the placeholder falls back to the
 * frame's min-height.
 */
const RESTING_COMPOSER_HEIGHT_KEY = "claxedo.composer.resting-height.v1"
let restingComposerHeight: number | undefined = (() => {
  try {
    const stored = Number(globalThis.localStorage?.getItem(RESTING_COMPOSER_HEIGHT_KEY))
    return Number.isFinite(stored) && stored > 40 && stored < 600 ? stored : undefined
  } catch {
    return undefined
  }
})()

const recordRestingComposerHeight = (height: number) => {
  if (!(height > 40 && height < 600)) return
  restingComposerHeight = height
  try {
    globalThis.localStorage?.setItem(RESTING_COMPOSER_HEIGHT_KEY, String(Math.round(height)))
  } catch {
    // Best effort: the in-memory value still covers this app run.
  }
}

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
  parentID?: string
  onNavigateParent: () => void
  mode: ComposerMode
  sessionRef?: () => SessionRef | undefined
  signedControlPlane?: () => boolean
  workspaceId?: () => string | undefined
  workspaceKind?: () => "cloud" | "user-hosted" | undefined
  navigateOnCreate?: boolean
  system?: string
  agent?: string
  canAbort?: () => boolean
  canPrompt?: () => boolean
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
  goalController?: {
    goal: () => RuntimeGoalSnapshot | null | undefined
    goalCapabilities: () => AgentRuntimeGoalCapabilities | undefined
    refreshGoal: (opts?: { force?: boolean }) => Promise<boolean>
    pauseGoal: () => Promise<unknown>
    resumeGoal: () => Promise<unknown>
    stopGoal: () => Promise<unknown>
    deleteGoal: () => Promise<unknown>
  }
  beforeInput?: JSX.Element
  registerRetry?: (retry?: PromptRetryAction) => void
}) {
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
  const parentID = createMemo(() => props.parentID ?? info()?.parentID)
  const child = createMemo(() => !!parentID())
  const showComposer = createMemo(() => !props.state.blocked() || child())

  const [store, setStore] = createStore({
    ready: false,
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
  // The dock renders at its final geometry the moment it is ready —
  // deliberately no spring here. The composer is the core interaction
  // surface: animating its reveal costs a motion-value loop plus per-frame
  // style writes on every session open, and any height it passes through
  // that differs from its resting height shifts the bottom-anchored
  // transcript above it.
  const value = createMemo(() => (open() ? 1 : 0))
  const dock = createMemo(() => (store.ready && props.state.dock()) || value() > 0.001)
  const rolled = createMemo(() => (props.revert?.items.length ? props.revert : undefined))
  const lift = createMemo(() => (rolled() ? 18 : 36 * value()))

  const openParent = () => {
    if (!parentID()) return
    props.onNavigateParent()
  }

  return (
    <div
      ref={props.setPromptDockRef}
      data-component="session-prompt-dock"
      classList={{
        "ui-session-prompt-dock": true,
        "w-full flex flex-col justify-center items-center pointer-events-none": true,
        "shrink-0 pb-3 bg-background-stronger": props.placement !== "inline",
      }}
    >
      <div
        classList={{
          "w-full px-3 pointer-events-auto": true,
          "max-w-[720px] px-0": props.placement === "inline",
          "md:max-w-192 md:mx-auto 2xl:max-w-[880px]": props.centered,
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

        <Show when={props.goalController} keyed>
          {(controller) => (
            <Show when={controller.goal()} keyed>
              {(goal) => (
                <Show when={controller.goalCapabilities()} keyed>
                  {(capabilities) => (
                    <SessionGoalDock
                      goal={goal}
                      capabilities={capabilities}
                      onPause={controller.pauseGoal}
                      onResume={controller.resumeGoal}
                      onDelete={controller.deleteGoal}
                    />
                  )}
                </Show>
              )}
            </Show>
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
                {/*
                  Not a distinct loader: this box reserves the EXACT space the
                  resting composer occupies — same min-h-[96px] frame, same
                  editor text position, same lift as the ready branch — so the
                  composer replaces it in place with zero layout shift. A
                  taller or unlifted placeholder moved the whole
                  bottom-anchored transcript when the real composer mounted.
                */}
                <div
                  class="w-full pointer-events-none"
                  // The SAME lift the ready branch applies (line below): the
                  // placeholder previously hardcoded -36px, which assumes the
                  // dock is open. For a plain session it never opens, so the
                  // composer's lift is 0 and the dock grew 36px at the swap,
                  // dragging the whole transcript up with it.
                  style={{ "margin-top": `${-lift()}px` }}
                >
                  <div
                    class="w-full rounded-xl bg-v2-background-bg-base px-4 pt-4 pb-2 leading-5 text-compact text-text-weak whitespace-pre-wrap"
                    style={{ "min-height": `${restingComposerHeight ?? 96}px` }}
                  >
                    {handoffPrompt() || language.t("prompt.loading")}
                  </div>
                </div>
              </>
            }
          >
            <Show when={dock()}>
              <div>
                <div>
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
              ref={(el) => {
                // Record the settled resting height for the next placeholder.
                // One rAF lets fonts/toolbar rows finish their first layout.
                requestAnimationFrame(() => {
                  if (el.isConnected) recordRestingComposerHeight(el.getBoundingClientRect().height)
                })
              }}
            >
              {props.beforeInput}
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
                      canPrompt={props.canPrompt}
                      status={props.status}
                      activeTurn={props.activeTurn}
                      goal={props.goalController?.goal}
                      goalCapabilities={props.goalController?.goalCapabilities}
                      refreshGoal={props.goalController?.refreshGoal}
                      stopGoal={props.goalController?.stopGoal}
                      registerRetry={props.registerRetry}
                    />
                  </Show>
                }
              >
                <div
                  ref={props.inputRef}
                  class="w-full rounded-[var(--radius-2xl)] border border-border-weak-base bg-background-base p-3 text-16-regular text-text-weak"
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
