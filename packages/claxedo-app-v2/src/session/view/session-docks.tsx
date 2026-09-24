import { createMemo, createSignal, Match, Show, Switch } from "solid-js"
import type { AgentRequest, AgentRequestReply, GoalAction } from "@/server"
import type { SessionView } from "@/session"
import { PermissionDock } from "./docks/permission-dock"
import { QuestionDock } from "./docks/question-dock"
import { GoalDock } from "./docks/goal-dock"
import { TodoDock } from "./docks/todo-dock"
import { todoDockOpen, type GoalActions } from "./docks/model"
import { turnActive } from "./timeline"
import "./docks/docks.css"

function RequestDock(props: { readonly view: SessionView; readonly request: AgentRequest }) {
  const reply = (value: AgentRequestReply) => props.view.reply(props.request.id, value)
  const stop = () => props.view.stop()
  const permission = () => (props.request.kind === "permission" ? props.request : undefined)
  const question = () => (props.request.kind === "question" ? props.request : undefined)
  return (
    <Switch>
      <Match when={permission()}>
        {(request) => <PermissionDock request={request().permission} onReply={reply} onStop={stop} />}
      </Match>
      <Match when={question()}>
        {(request) => <QuestionDock request={request().question} onReply={reply} onStop={stop} />}
      </Match>
    </Switch>
  )
}

function goalActions(view: SessionView): GoalActions {
  return Object.fromEntries(view.goalActions().map((action: GoalAction) => [action, () => view.controlGoal(action)]))
}

export function SessionDocks(props: { readonly view: SessionView }) {
  const [todoCollapsed, setTodoCollapsed] = createSignal(true)
  const request = createMemo(() => props.view.requests()[0])
  const todos = () => props.view.todos()
  const todoOpen = () => {
    const list = todos()
    const done = list.length > 0 && list.every((todo) => todo.status === "completed" || todo.status === "cancelled")
    const status = props.view.status()
    return todoDockOpen({ count: list.length, done, live: status.kind !== "unknown" && turnActive(status) })
  }
  return (
    <div data-slot="session-docks">
      <Show when={request()} keyed>
        {(current) => <RequestDock view={props.view} request={current} />}
      </Show>
      <Show when={props.view.goal()}>{(goal) => <GoalDock goal={goal()} actions={goalActions(props.view)} />}</Show>
      <Show when={!request() && todoOpen()}>
        <TodoDock todos={todos()} collapsed={todoCollapsed()} onToggle={() => setTodoCollapsed((value) => !value)} />
      </Show>
    </div>
  )
}
