import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch } from "solid-js"
import { Composer, promptText, sessionComposerKey, useComposerStore } from "@/composer"
import { usePhone } from "@/lib/viewport"
import { FailureBoundary, FailureNotice } from "@/lib/failure"
import { sessionId, useServer, type SessionRef } from "@/server"
import { usePanel } from "@/panel"
import { useSessionStores, type SessionView } from "@/session"
import { sessionPath, useCommands, useShellRoute, type PaneProps } from "@/shell"
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
import { floatingPeekStep, type FloatingPeekState } from "./floating-peek"
import { PreviousMessagesRow, turnActive } from "./timeline"
import "./session-screen.css"
import "./session-floating.css"

function ChildNotice(props: { readonly t: SessionScreenText; readonly onBack: () => void }) {
  return (
    <div class="w-full px-3 py-2 text-center text-12-regular text-text-weaker">
      <span>{props.t("sessionScreen.child.promptDisabled")} </span>
      <button
        type="button"
        class="text-text-weak underline-offset-2 transition-colors hover:text-text-base hover:underline"
        onClick={() => props.onBack()}
      >
        {props.t("sessionScreen.child.backToParent")}
      </button>
    </div>
  )
}

function SessionBody(props: { readonly view: SessionView; readonly paneId: string; readonly active: boolean; readonly floating: boolean }) {
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
  const lift = () => (todo.open() && !props.floating ? 36 : 0)
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
  const handleKeyDown = createSessionScreenKeydownHandler({
    active: () => props.active,
    dialogActive: () => dialog.active,
    inputEl: () => body?.querySelector<HTMLDivElement>('[data-component="prompt-input"]') ?? undefined,
    composerBlocked: () => props.view.requests().length > 0 || !!parentId(),
    prompt: { cursor: () => draft().cursor, length: () => promptText(draft().prompt).length },
    markScrollGesture: () => scroll.props.onMarkScrollGesture(),
  })
  createMessageLinks({ view: () => props.view, users, scroll, active: () => props.active, commands: useCommands(), t })
  document.addEventListener("keydown", handleKeyDown)
  onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
  const setDock = createDockFollow(scroll)
  return (
    <div ref={body} data-slot="session-screen-body" classList={{ "session-floating-overlay": props.floating }}>
      <div data-slot="session-screen-transcript" classList={{ "session-floating-tab": props.floating }}>
        <Show when={props.floating}>
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
          <SessionTimeline view={props.view} host={host} active={props.active} scroll={scroll} onNavigateParent={toParent} />
        </div>
      </div>
      <div
        ref={setDock}
        data-component="session-prompt-dock"
        class="ui-session-prompt-dock w-full flex flex-col justify-center items-center pointer-events-none shrink-0 pb-3"
        classList={{ "session-floating-dock": props.floating }}
      >
        <div data-slot="session-screen-dock" class="w-full px-3 pointer-events-auto md:max-w-192 md:mx-auto 2xl:max-w-[880px]">
          <SessionDocks view={props.view} />
          <Show when={props.view.requests().length === 0}>
            <Show when={todo.open()}>
              <TodoDockSlot view={props.view} dock={todo} />
            </Show>
            <div class="relative z-10" style={{ "margin-top": `${-lift()}px` }}>
              <Show when={!parentId()} fallback={<ChildNotice t={t} onBack={toParent} />}>
                <Composer
                  composerKey={sessionComposerKey(props.view.ref)}
                  placementId={props.view.ref.placementId}
                  view={props.view}
                  sessionHarness={props.view.row()?.harness}
                  attachmentWorkspace={true}
                  afterAccepted={() => {
                    setSends((count) => count + 1)
                    queueEdit.accepted()
                  }}
                  queuedEdit={queueEdit.edit}
                  dropZone={() => body}
                  collapsible={props.floating}
                />
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

export function SessionScreen(props: PaneProps<SessionRef>) {
  const t = useSessionScreenText()
  const phone = usePhone()
  const stores = useSessionStores()
  const panel = usePanel()
  const floating = () => panel.maximized() && props.active
  const view = createMemo(() => stores.open(props.state))
  const failure = () => {
    const state = view().state()
    return state.kind === "failed" ? state : undefined
  }
  return (
    <section
      data-component="session-screen"
      data-session-id={props.state.sessionId}
      data-session-presentation={floating() ? "floating" : undefined}
      aria-label={view().row()?.title ?? t("sessionScreen.untitled")}
    >
      <FailureBoundary title={t("sessionScreen.failed")} retryLabel={t("sessionScreen.action.retry")}>
        <Switch fallback={<SessionBody view={view()} paneId={props.paneId} active={props.active} floating={floating()} />}>
          <Match when={view().state().kind === "missing"}>
            <div class="flex h-full items-center justify-center px-4 text-text-weak">
              <div data-testid="session-unavailable" data-session-id={props.state.sessionId}>
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
            <SessionTimelineSkeleton centered={!phone()} sessionId={props.state.sessionId} />
          </Match>
        </Switch>
      </FailureBoundary>
    </section>
  )
}
