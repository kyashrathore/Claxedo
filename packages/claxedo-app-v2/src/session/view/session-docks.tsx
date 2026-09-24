import { createMemo, createSignal, Match, Show, Switch } from "solid-js"
import type { AgentRequest, AgentRequestReply, GoalAction } from "@/server"
import type { SessionView } from "@/session"
import { PermissionDock } from "./docks/permission-dock"
import { QuestionDock } from "./docks/question-dock"
import { GoalDock } from "./docks/goal-dock"
import { SessionTodoDock } from "./docks/todo-dock"
import { todoDockOpen, type GoalActions } from "./docks/model"
import { turnActive } from "./timeline"
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

function goalActions(view: SessionView): GoalActions {
  return Object.fromEntries(view.goalActions().map((action: GoalAction) => [action, () => view.controlGoal(action)]))
}

export function SessionDocks(props: { readonly view: SessionView }) {
  const request = createMemo(() => props.view.requests()[0])
  return (
    <div data-slot="session-docks">
      <Show when={request()} keyed>
        {(current) => <RequestDock view={props.view} request={current} />}
      </Show>
      <Show when={props.view.goal()}>{(goal) => <GoalDock goal={goal()} actions={goalActions(props.view)} />}</Show>
    </div>
  )
}

const collapsedTodos = new Map<string, boolean>()

export function createTodoDock(view: () => SessionView) {
  const key = () => view().ref.sessionId
  const [collapsed, setCollapsed] = createSignal(collapsedTodos.get(key()) ?? false)
  const open = () => {
    const list = view().todos()
    const done = list.length > 0 && list.every((todo) => todo.status === "completed" || todo.status === "cancelled")
    const status = view().status()
    return todoDockOpen({ count: list.length, done, live: status.kind !== "unknown" && turnActive(status) })
  }
  return {
    open,
    collapsed,
    toggle: () => {
      const next = !collapsed()
      collapsedTodos.set(key(), next)
      setCollapsed(next)
    },
  }
}

export function TodoDockSlot(props: { readonly view: SessionView; readonly dock: ReturnType<typeof createTodoDock> }) {
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
