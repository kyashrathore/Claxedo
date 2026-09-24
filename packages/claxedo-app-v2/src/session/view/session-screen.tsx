import { createMemo, Match, Show, Switch } from "solid-js"
import { Composer, sessionComposerKey } from "@/composer"
import { useElapsed } from "@/lib/delay"
import { FailureBoundary, FailureNotice } from "@/lib/failure"
import { useServer, type SessionRef } from "@/server"
import { useSessionStores, type SessionView } from "@/session"
import { sessionPath, useShellRoute, type PaneProps } from "@/shell"
import { Button, useDialog } from "@/ui"
import { useWorkbench } from "@/workbench"
import { PlanDialog } from "./plan-dialog"
import { createQueueEdit } from "./queue-edit"
import { SessionDocks } from "./session-docks"
import { SessionTimeline } from "./session-timeline"
import { useSessionScreenText, type SessionScreenText } from "./text"
import { createTimelineHost } from "./timeline-host"
import "./session-screen.css"

function Loading(props: { readonly t: SessionScreenText }) {
  const elapsed = useElapsed()
  return (
    <Show when={elapsed()}>
      <p role="status" data-slot="session-screen-loading">
        {props.t("sessionScreen.loading")}
      </p>
    </Show>
  )
}

function ChildNotice(props: { readonly t: SessionScreenText; readonly onBack: () => void }) {
  return (
    <div data-slot="session-child-notice">
      <span>{props.t("sessionScreen.child.promptDisabled")}</span>
      <Button size="small" variant="ghost" onClick={() => props.onBack()}>
        {props.t("sessionScreen.child.backToParent")}
      </Button>
    </div>
  )
}

function SessionBody(props: { readonly view: SessionView; readonly paneId: string; readonly active: boolean }) {
  const t = useSessionScreenText()
  const server = useServer()
  const stores = useSessionStores()
  const workbench = useWorkbench()
  const routing = useShellRoute()
  const dialog = useDialog()
  const openPlan = (plan: Parameters<typeof PlanDialog>[0]["plan"]) =>
    dialog.show(() => <PlanDialog plan={plan} fallbackTitle={t("sessionScreen.plan.title")} />)
  const host = createTimelineHost({ view: props.view, stores, server, workbench, routing, t, openPlan })
  const parentId = () => props.view.row()?.parentSessionId
  const toParent = () => {
    const parent = parentId()
    if (parent) routing.navigate(sessionPath({ placementId: props.view.ref.placementId, sessionId: parent }))
  }
  const queueEdit = createQueueEdit(props.view)
  return (
    <div data-slot="session-screen-body">
      <div data-slot="session-screen-timeline">
        <SessionTimeline view={props.view} host={host} active={props.active} onNavigateParent={toParent} />
      </div>
      <div data-slot="session-screen-dock">
        <SessionDocks view={props.view} />
        <Show when={!parentId()} fallback={<ChildNotice t={t} onBack={toParent} />}>
          <Composer
            composerKey={sessionComposerKey(props.view.ref)}
            placementId={props.view.ref.placementId}
            view={props.view}
            lockedHarness={props.view.row()?.harness}
            attachmentWorkspace={true}
            afterAccepted={queueEdit.accepted}
          />
        </Show>
      </div>
    </div>
  )
}

export function SessionScreen(props: PaneProps<SessionRef>) {
  const t = useSessionScreenText()
  const stores = useSessionStores()
  const view = createMemo(() => stores.open(props.state))
  const failure = () => {
    const state = view().state()
    return state.kind === "failed" ? state : undefined
  }
  return (
    <section data-component="session-screen" data-session-id={props.state.sessionId} aria-label={view().row()?.title ?? t("sessionScreen.untitled")}>
      <FailureBoundary title={t("sessionScreen.failed")} retryLabel={t("sessionScreen.action.retry")}>
        <Switch fallback={<SessionBody view={view()} paneId={props.paneId} active={props.active} />}>
          <Match when={view().state().kind === "missing"}>
            <p role="alert" data-slot="session-screen-missing">
              {t("sessionScreen.missing")}
            </p>
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
            <Loading t={t} />
          </Match>
        </Switch>
      </FailureBoundary>
    </section>
  )
}
