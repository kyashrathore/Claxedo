import { createMemo, createSignal, Match, Show, Switch, untrack } from "solid-js"
import { persistedSignal, preferenceKey, tabStorage } from "@/lib/persisted"
import type { SessionControls } from "@/access"
import type { AgentRequest, AgentRequestReply, AppError } from "@/server"
import type { SessionView } from "@/session"
import { draftPath, useShellRoute } from "@/shell"
import { Button } from "@/ui"
import { createDockAction } from "./docks/dock-action"
import { PermissionDock } from "./docks/permission-dock"
import { QuestionDock } from "./docks/question-dock"
import { GoalDock } from "./docks/goal-dock"
import { InterruptedDock } from "./docks/interrupted-dock"
import { SessionTodoDock } from "./docks/todo-dock"
import { goalActions, todoDockOpen } from "./docks/model"
import { useSessionScreenText } from "./text"
import "./docks/docks.css"

function RequestDock(props: { readonly view: SessionView; readonly request: AgentRequest }) {
  const reply = (value: AgentRequestReply) => void props.view.reply(props.request.id, value)
  const replyState = () => props.view.requestState(props.request.id)
  const stop = () => props.view.stop()
  const permission = () => (props.request.kind === "permission" ? props.request : undefined)
  const question = () => (props.request.kind === "question" ? props.request : undefined)
  return (
    <Switch>
      <Match when={permission()}>
        {(request) => <PermissionDock request={request().permission} replyState={replyState()} onReply={reply} onStop={stop} />}
      </Match>
      <Match when={question()}>
        {(request) => <QuestionDock request={request().question} replyState={replyState()} onReply={reply} onStop={stop} />}
      </Match>
    </Switch>
  )
}

function RequestReadError(props: { readonly view: SessionView; readonly error: AppError }) {
  const t = useSessionScreenText()
  const [retrying, setRetrying] = createSignal(false)
  const retry = async () => {
    if (retrying()) return
    setRetrying(true)
    try {
      await props.view.reload()
    } finally {
      setRetrying(false)
    }
  }
  return (
    <div role="alert" class="rounded-lg border border-border-weak-base bg-background-base p-3 text-text-base">
      <div>{t("sessionScreen.requests.loadFailed")}</div>
      <pre class="whitespace-pre-wrap break-all text-12-regular">{props.error.message}</pre>
      <button type="button" disabled={retrying()} onClick={() => void retry()}>
        {t("sessionScreen.action.retry")}
      </button>
    </div>
  )
}

function RuntimeMissingDock(props: { readonly view: SessionView }) {
  const t = useSessionScreenText()
  const routing = useShellRoute()
  const action = createDockAction<"retry">()
  return (
    <Show when={props.view.runtimeMissing()}>
      <section role="alert" class="mb-2 rounded-lg border border-border-weak-base bg-background-base p-3 text-text-base">
        <div class="text-12-regular">{t("sessionScreen.runtime.missing")}</div>
        <div class="flex flex-wrap gap-3">
          <Button variant="neutral" size="small" onClick={() => routing.navigate(draftPath(props.view.ref.placementId))}>
            {t("sessionScreen.runtime.newSession")}
          </Button>
          <Button variant="neutral" size="small" disabled={action.running()} onClick={() => void action.run("retry", props.view.reload)}>
            {t(action.running() ? "sessionScreen.action.loading" : "sessionScreen.action.retry")}
          </Button>
        </div>
      </section>
    </Show>
  )
}

export function SessionDocks(props: { readonly view: SessionView; readonly controls: SessionControls; readonly todo: ReturnType<typeof createTodoDock> }) {
  const request = createMemo(() => props.view.requests()[0])
  return (
    <>
      <div data-slot="session-docks" hidden={!props.controls.send}>
        <InterruptedDock view={props.view} />
        <RuntimeMissingDock view={props.view} />
        <Show when={!props.view.runtimeMissing() && props.view.requestsError()}>{(error) => <RequestReadError view={props.view} error={error()} />}</Show>
        <Show when={request()} keyed>
          {(current) => <RequestDock view={props.view} request={current} />}
        </Show>
        <Show when={props.view.goal()}>{(goal) => <GoalDock goal={goal()} actions={goalActions(props.view.goalActions(), props.view.controlGoal, props.controls)} />}</Show>
      </div>
      <div hidden={props.controls.send && !!request()}>
        <Show when={props.todo.open()}>
          <TodoDockSlot view={props.view} dock={props.todo} />
        </Show>
      </div>
    </>
  )
}

const readCollapsed = (value: unknown) => (typeof value === "boolean" ? value : undefined)

export function createTodoDock(view: () => SessionView) {
  const key = preferenceKey("session", untrack(() => view().ref.sessionId), "todo-collapsed")
  const [collapsed, setCollapsed] = persistedSignal(key, false, readCollapsed, tabStorage())
  const open = () => {
    const list = view().todos()
    const done = list.length > 0 && list.every((todo) => todo.status === "completed" || todo.status === "cancelled")
    return todoDockOpen({ count: list.length, done })
  }
  return {
    open,
    collapsed,
    toggle: () => setCollapsed((value) => !value),
  }
}

function TodoDockSlot(props: { readonly view: SessionView; readonly dock: ReturnType<typeof createTodoDock> }) {
  const t = useSessionScreenText()
  return (
    <SessionTodoDock
      todos={props.view.todos()}
      collapsed={props.dock.collapsed()}
      onToggle={props.dock.toggle}
      collapseLabel={t("sessionScreen.todo.collapse")}
      expandLabel={t("sessionScreen.todo.expand")}
      dockProgress={1}
    />
  )
}
