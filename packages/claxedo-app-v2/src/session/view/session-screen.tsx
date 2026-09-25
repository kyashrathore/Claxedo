import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch } from "solid-js"
import { Composer, promptText, sessionComposerKey, useComposerStore, type ComposerRecovery } from "@/composer"
import { usePhone } from "@/lib/viewport"
import { FailureBoundary, FailureNotice } from "@/lib/failure"
import { sessionId, useServer, type SessionRef } from "@/server"
import { usePanel } from "@/panel"
import { useSessionStores, type SessionView } from "@/session"
import { draftPath, sessionPath, settingsPath, useCommands, useShellRoute, type PaneProps } from "@/shell"
import { useDialog } from "@/ui"
import { useWorkbench } from "@/workbench"
import { createQueueEdit } from "./queue-edit"
import { createTodoDock, SessionDocks, TodoDockSlot } from "./session-docks"
import { SessionTimeline, userMessages } from "./session-timeline"
import { createMessageLinks } from "./message-links"
import { useSessionScreenText, type SessionScreenText } from "./text"
import { createTimelineHost } from "./timeline-host"
import { createTimelineScroll } from "./timeline-scroll"
import { createDockFollow } from "./dock-follow"
import { SessionTimelineSkeleton } from "./session-timeline-skeleton"
import { createSessionScreenKeydownHandler } from "./session-screen-keydown"
import { SessionConnectionLine } from "./connection-line"
import { commitDeltasEachFrame } from "./delta-frames"
import { registerSessionCommands } from "./session-commands"
import { recoverTurn } from "./turn-recovery-actions"
import { floatingPeekStep, type FloatingPeekState } from "./floating-peek"
import { PreviousMessagesRow, turnActive } from "./timeline"
import "./session-screen.css"
import "./session-floating.css"

function ChildNotice(props: { readonly t: SessionScreenText; readonly readOnly: boolean; readonly onBack: () => void }) {
  return (
    <div class="w-full px-3 py-2 text-center text-12-regular text-text-weaker">
      <span>{props.t("sessionScreen.child.promptDisabled")} </span>
      <Show when={!props.readOnly}>
        <button
          type="button"
          class="text-text-weak underline-offset-2 transition-colors hover:text-text-base hover:underline"
          onClick={() => props.onBack()}
        >
          {props.t("sessionScreen.child.backToParent")}
        </button>
      </Show>
    </div>
  )
}

type SessionSurfaceProps = {
  readonly sessionRef: SessionRef
  readonly active: boolean
  readonly readOnly?: boolean
}

function SessionBody(props: {
  readonly view: SessionView
  readonly active: boolean
  readonly readOnly: boolean
  readonly floating: boolean
}) {
  const t = useSessionScreenText()
  const server = useServer()
  const stores = useSessionStores()
  const workbench = useWorkbench()
  const routing = useShellRoute()
  const panel = usePanel()
  const dialog = useDialog()
  const parentId = () => props.view.row()?.parentSessionId
  const [parent, setParent] = createSignal<SessionView>()
  createEffect(on(parentId, (id) => setParent(id ? stores.open({ ...props.view.ref, sessionId: sessionId(id) }) : undefined)))
  const host = createTimelineHost({ view: props.view, parent, stores, server, workbench, routing, t, panel })
  const toParent = () => {
    const parent = parentId()
    if (parent) routing.navigate(sessionPath({ placementId: props.view.ref.placementId, sessionId: parent }))
  }
  const queueEdit = createQueueEdit(props.view)
  const working = () => {
    const status = props.view.status()
    return status.kind !== "unknown" && turnActive(status)
  }
  const scroll = createTimelineScroll({ view: () => props.view, active: () => props.active, working })
  const todo = createTodoDock(() => props.view)
  const blocked = () => props.view.requests().length > 0
  const users = createMemo(() => userMessages(props.view))
  const [peekToggles, setPeekToggles] = createSignal(0)
  const [sends, setSends] = createSignal(0)
  const peek = createMemo<FloatingPeekState>((previous) =>
    floatingPeekStep(previous, {
      floating: props.floating,
      toggles: peekToggles(),
      sends: sends(),
      sessionId: props.view.ref.sessionId,
      loaded: !!props.view.conversation(),
      turns: users().length,
    }),
  )
  const transcriptCollapsed = () => props.floating && !peek().peeked
  const composers = useComposerStore()
  let body: HTMLDivElement | undefined
  const draft = () => composers.draft(sessionComposerKey(props.view.ref))
  const driving = () => props.active && !props.readOnly
  const handleKeyDown = createSessionScreenKeydownHandler({
    active: driving,
    dialogActive: () => dialog.active,
    inputEl: () => body?.querySelector<HTMLDivElement>('[data-component="prompt-input"]') ?? undefined,
    composerBlocked: () => blocked() || !!parentId(),
    prompt: { cursor: () => draft().cursor, length: () => promptText(draft().prompt).length },
    markScrollGesture: () => scroll.props.onMarkScrollGesture(),
  })
  const commands = useCommands()
  createMessageLinks({ view: () => props.view, users, scroll, active: driving, commands, t })
  registerSessionCommands({ commands, placementId: () => props.view.ref.placementId, active: driving, navigate: (path) => routing.navigate(path), t })
  let recovery: ComposerRecovery | undefined
  const recover = (kind: Parameters<typeof recoverTurn>[2], userMessageId: string) =>
    recoverTurn(props.view, {
      startNewSession: () => routing.navigate(draftPath(props.view.ref.placementId)),
      openProviders: () => routing.navigate(settingsPath("models")),
      switchModelAndResend: async (text) => recovery?.switchModelAndResend(text),
      resend: (text) => recovery?.resend(text),
    }, kind, userMessageId)
  document.addEventListener("keydown", handleKeyDown)
  onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
  const setDock = createDockFollow(scroll)
  return (
    <div ref={body} data-slot="session-screen-body" classList={{ "session-floating-overlay": props.floating }}>
      <div data-slot="session-screen-transcript" classList={{ "session-floating-tab": props.floating }}>
        <Show when={props.floating && users().length > 0}>
          <div class="session-floating-peek">
            <PreviousMessagesRow
              count={users().length}
              expanded={peek().peeked}
              testId="session-transcript-peek"
              onReveal={() => setPeekToggles((count) => count + 1)}
              t={host.t}
            />
          </div>
        </Show>
        <div
          data-slot="session-screen-timeline"
          data-session-transcript-collapsed={transcriptCollapsed() ? "true" : undefined}
          classList={{ "session-floating-timeline": props.floating, "session-floating-timeline-collapsed": transcriptCollapsed() }}
        >
          <SessionTimeline view={props.view} host={host} active={props.active} scroll={scroll} onRecover={recover} />
        </div>
      </div>
      <div
        ref={setDock}
        data-component="session-prompt-dock"
        class="ui-session-prompt-dock w-full flex flex-col justify-center items-center pointer-events-none shrink-0 pb-3"
        classList={{ "session-floating-dock": props.floating }}
      >
        <div class="w-full px-3 pointer-events-auto md:max-w-192 md:mx-auto 2xl:max-w-[880px]">
          <SessionDocks view={props.view} />
          <div hidden={blocked()}>
            <Show when={todo.open()}>
              <TodoDockSlot view={props.view} dock={todo} />
            </Show>
            <div class="relative z-10">
              <Show when={!props.readOnly}>
                <SessionConnectionLine />
              </Show>
              <Show when={!parentId() && !props.readOnly} fallback={<ChildNotice t={t} readOnly={props.readOnly} onBack={toParent} />}>
                <Composer
                  composerKey={sessionComposerKey(props.view.ref)}
                  placementId={props.view.ref.placementId}
                  view={props.view}
                  sessionHarness={props.view.row()?.harness}
                  attachmentWorkspace={true}
                  hidden={blocked()}
                  afterAccepted={() => {
                    setSends((count) => count + 1)
                    queueEdit.accepted()
                  }}
                  queuedEdit={queueEdit.edit}
                  dropZone={() => body}
                  collapsible={props.floating}
                  registerRecovery={(next) => (recovery = next)}
                />
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function SessionSurface(props: SessionSurfaceProps) {
  const t = useSessionScreenText()
  const phone = usePhone()
  const stores = useSessionStores()
  const panel = usePanel()
  const floating = () => !props.readOnly && panel.maximized() && props.active
  const view = createMemo(() => stores.open(props.sessionRef))
  commitDeltasEachFrame(view)
  const failure = () => {
    const state = view().state()
    return state.kind === "failed" ? state : undefined
  }
  return (
    <section
      data-component="session-screen"
      data-testid="session-page-root"
      data-session-id={props.sessionRef.sessionId}
      data-session-presentation={floating() ? "floating" : undefined}
      aria-label={view().row()?.title ?? t("sessionScreen.untitled")}
    >
      <Show when={!props.readOnly && !view().row()?.parentSessionId}>
        <h1 class="sr-only">{view().row()?.title || t("sessionScreen.untitled")}</h1>
      </Show>
      <FailureBoundary title={t("sessionScreen.failed")} retryLabel={t("sessionScreen.action.retry")}>
        <Switch fallback={<SessionBody view={view()} active={props.active} readOnly={props.readOnly === true} floating={floating()} />}>
          <Match when={view().state().kind === "missing"}>
            <div class="flex h-full items-center justify-center px-4 text-text-weak">
              <div data-testid="session-unavailable" data-session-id={props.sessionRef.sessionId}>
                Session unavailable
              </div>
            </div>
          </Match>
          <Match when={failure()}>
            {(state) => (
              <FailureNotice
                title={t("sessionScreen.failed")}
                message={state().error.message}
                retryLabel={t("sessionScreen.action.retry")}
                onRetry={() => void view().reload()}
              />
            )}
          </Match>
          <Match when={view().state().kind === "loading" && !view().conversation()}>
            <SessionTimelineSkeleton centered={!phone()} sessionId={props.sessionRef.sessionId} />
          </Match>
        </Switch>
      </FailureBoundary>
    </section>
  )
}

export function SessionScreen(props: PaneProps<SessionRef>) {
  return <SessionSurface sessionRef={props.state} active={props.active} />
}
