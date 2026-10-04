import { createEffect, createMemo, createSignal, Match, on, Show, Switch } from "solid-js"
import { Composer, promptText, SelectionComment, sessionComposerKey, useComposerStore } from "@/composer"
import { usePhone } from "@/lib/viewport"
import { FailureBoundary, FailureNotice } from "@/lib/failure"
import { sessionId, useServer, type SessionLocation } from "@/server"
import { usePanel } from "@/panel"
import { useAccess, type SessionControls } from "@/access"
import { useSessionStores, type SessionView } from "@/session"
import { sessionPath, useCommands, useShellRoute, type PaneProps } from "@/shell"
import { DockLayout, useDialog } from "@/ui"
import { holdPaneReveal, useWorkbench } from "@/workbench"
import { createQueueEdit } from "./queue-edit"
import { createTodoDock, SessionDocks } from "./session-docks"
import { SessionTimeline, userMessages } from "./session-timeline"
import { createMessageLinks } from "./message-links"
import { useSessionScreenText, type SessionScreenText } from "./text"
import { createTimelineHost } from "./timeline-host"
import { createTimelineScroll } from "./timeline-scroll"
import { createDockFollow } from "./dock-follow"
import { navTurns } from "./nav-turns"
import { SessionTimelineSkeleton } from "./session-timeline-skeleton"
import { installSessionScreenKeydown } from "./session-screen-keydown"
import { SessionConnectionLine } from "./connection-line"
import { commitDeltasWhileShown } from "./delta-frames"
import { markSeenWhileShown } from "./seen-while-shown"
import { createScreenTurnRecovery } from "./turn-recovery-actions"
import { createFloatingPeek } from "./floating-peek"
import { PreviousMessagesRow, turnActive, type TimelineHost } from "./timeline"
import { PlacementStateCards } from "./workspace-sleep"
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

function FloatingPeekRow(props: {
  readonly count: number
  readonly peek: ReturnType<typeof createFloatingPeek>
  readonly t: TimelineHost["t"]
}) {
  return (
    <div class="session-floating-peek">
      <PreviousMessagesRow
        count={props.count}
        expanded={props.peek.peeked()}
        testId="session-transcript-peek"
        onReveal={props.peek.toggle}
        t={props.t}
      />
    </div>
  )
}

type SessionSurfaceProps = {
  readonly sessionRef: SessionLocation
  readonly active: boolean
  readonly readOnly?: boolean
}

function SessionBody(props: {
  readonly view: SessionView
  readonly active: boolean
  readonly readOnly: boolean
  readonly floating: boolean
  readonly controls: SessionControls
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
  createEffect(on(parentId, (id) => setParent(id && props.controls.owner ? stores.open({ ...props.view.ref, sessionId: sessionId(id) }) : undefined)))
  const host = createTimelineHost({ view: props.view, parent, stores, server, workbench, routing, t, panel })
  const toParent = () => {
    const parent = parentId()
    if (parent) routing.navigate(sessionPath({ placementId: props.view.ref.placementId, sessionId: parent }))
  }
  const composers = useComposerStore()
  const queueEdit = createQueueEdit(props.view, composers)
  const working = () => {
    const status = props.view.status()
    return status.kind !== "unknown" && turnActive(status)
  }
  const users = createMemo(() => userMessages(props.view))
  const turns = createMemo(() => navTurns(props.view.outline(), users()))
  const scroll = createTimelineScroll({ view: () => props.view, active: () => props.active, working })
  const todo = createTodoDock(() => props.view)
  const blocked = () => props.view.requests().length > 0 || props.view.runtimeMissing()
  const peek = createFloatingPeek({
    floating: () => props.floating,
    sessionId: () => props.view.ref.sessionId,
    loaded: () => !!props.view.conversation(),
    turns: () => users().length,
  })
  const transcriptCollapsed = () => props.floating && !peek.peeked()
  let body: HTMLDivElement | undefined
  let timeline: HTMLDivElement | undefined
  const draft = () => composers.draft(sessionComposerKey(props.view.ref))
  const driving = () => props.active && !props.readOnly
  const composing = () => (!parentId() || !props.controls.owner) && !props.readOnly
  installSessionScreenKeydown({
    active: driving,
    dialogActive: () => dialog.active,
    inputEl: () => body?.querySelector<HTMLDivElement>('[data-component="prompt-input"]') ?? undefined,
    composerBlocked: () => blocked() || !!parentId(),
    prompt: { cursor: () => draft().cursor, length: () => promptText(draft().prompt).length },
    markScrollGesture: () => scroll.props.onMarkScrollGesture(),
  })
  const commands = useCommands()
  createMessageLinks({ turns, scroll, active: driving, commands, t })
  const recovery = createScreenTurnRecovery(() => props.view, (path) => routing.navigate(path))
  const dock = createDockFollow(scroll)
  return (
    <div ref={body} data-slot="session-screen-body" classList={{ "session-floating-overlay": props.floating }} style={{ "--session-dock-overhang": `${dock.overhang()}px` }}>
      <div data-slot="session-screen-transcript" classList={{ "session-floating-tab": props.floating }}>
        <Show when={props.floating && users().length > 0}>
          <FloatingPeekRow count={users().length} peek={peek} t={host.t} />
        </Show>
        <Show when={props.active && composing() && props.controls.send}>
          <SelectionComment root={() => timeline} composerKey={() => sessionComposerKey(props.view.ref)} source={{ kind: "conversation" }} />
        </Show>
        <div
          ref={timeline}
          data-slot="session-screen-timeline"
          data-session-transcript-collapsed={transcriptCollapsed() ? "true" : undefined}
          classList={{ "session-floating-timeline": props.floating, "session-floating-timeline-collapsed": transcriptCollapsed() }}
        >
          <SessionTimeline view={props.view} queued={queueEdit.queued} navTurns={turns()} host={host} active={props.active} onScreen={!transcriptCollapsed()} scroll={scroll} onRecover={props.controls.owner ? recovery.recover : undefined} follow={!props.controls.send} />
        </div>
      </div>
      <div
        ref={dock.ref}
        data-component="session-prompt-dock"
        class="ui-session-prompt-dock w-full flex flex-col justify-center items-center pointer-events-none shrink-0 pb-3"
        classList={{ "session-floating-dock": props.floating }}
      >
        <DockLayout
          class="w-full px-3 pointer-events-auto md:max-w-192 md:mx-auto 2xl:max-w-[880px]"
          replace={props.controls.send && blocked()}
          overlay={<SessionDocks view={props.view} controls={props.controls} todo={todo} />}
          onOverhang={dock.setOverhang}
        >
          <Show when={!props.readOnly}>
            <SessionConnectionLine />
          </Show>
          <Show when={composing()} fallback={<ChildNotice t={t} readOnly={props.readOnly} onBack={toParent} />}>
            <PlacementStateCards placementId={props.view.ref.placementId} />
            <Composer
              readOnly={!props.controls.send}
              manageSession={props.controls.owner}
              composerKey={sessionComposerKey(props.view.ref)}
              placementId={props.view.ref.placementId}
              view={props.view}
              attachmentWorkspace={props.controls.owner}
              hidden={blocked()}
              afterAccepted={() => {
                peek.sent()
                scroll.resume()
              }}
              queuedEdit={queueEdit.edit}
              dropZone={() => body}
              collapsible={props.floating}
              registerRecovery={recovery.register}
            />
          </Show>
        </DockLayout>
      </div>
    </div>
  )
}

export function SessionSurface(props: SessionSurfaceProps) {
  const access = useAccess()
  const controls = () => access.session(props.sessionRef)
  const standing = createMemo<{ readonly sessionId: string; readonly shared: boolean }>((was) => {
    const id = props.sessionRef.sessionId
    return { sessionId: id, shared: !controls().owner || (was?.sessionId === id && was.shared) }
  })
  const unshared = () => standing().shared && controls().owner
  const t = useSessionScreenText()
  const phone = usePhone()
  const stores = useSessionStores()
  const panel = usePanel()
  const floating = () => !props.readOnly && controls().send && panel.maximized() && props.active
  const view = createMemo(() => stores.open(props.sessionRef))
  commitDeltasWhileShown(view)
  markSeenWhileShown(view, () => props.active && !props.readOnly, stores.list)
  holdPaneReveal(() => view().state().kind === "loading")
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
        <Switch fallback={<SessionBody view={view()} active={props.active} readOnly={props.readOnly === true} floating={floating()} controls={controls()} />}>
          <Match when={view().state().kind === "missing" || unshared() || (!controls().owner && failure()?.error.status === 403)}>
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
            <SessionTimelineSkeleton centered={!phone()} />
          </Match>
        </Switch>
      </FailureBoundary>
    </section>
  )
}

export function SessionScreen(props: PaneProps<SessionLocation>) {
  return <SessionSurface sessionRef={props.state} active={props.active} />
}
