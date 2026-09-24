import { For, Show, createMemo } from "solid-js"
import type { Todo } from "@/server"
import { Checkbox, Icon } from "@/ui"
import { useSessionScreenText } from "../text"

function activeTodo(todos: readonly Todo[]) {
  return (
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "pending") ??
    todos.filter((todo) => todo.status === "completed").at(-1) ??
    todos[0]
  )
}

export function TodoDock(props: { todos: readonly Todo[]; collapsed: boolean; onToggle: VoidFunction }) {
  const t = useSessionScreenText()
  const done = createMemo(() => props.todos.filter((todo) => todo.status === "completed").length)
  const progress = () => t("sessionScreen.todo.progress", { done: done(), total: props.todos.length })
  const preview = createMemo(() => activeTodo(props.todos)?.content ?? "")
  return (
    <section data-component="todo-dock" data-collapsed={props.collapsed ? "true" : undefined} aria-label={progress()}>
      <button
        type="button"
        data-slot="todo-dock-toggle"
        aria-expanded={!props.collapsed}
        aria-label={t(props.collapsed ? "sessionScreen.todo.expand" : "sessionScreen.todo.collapse")}
        onClick={props.onToggle}
      >
        <span data-slot="todo-dock-count">{progress()}</span>
        <Show when={props.collapsed}>
          <span data-slot="todo-dock-preview">{preview()}</span>
        </Show>
        <span data-slot="todo-dock-chevron" aria-hidden="true">
          <Icon name="chevron-down" size="small" />
        </span>
      </button>
      <Show when={!props.collapsed}>
        <ul data-slot="todo-dock-list">
          <For each={props.todos}>
            {(todo) => (
              <li data-slot="todo-dock-item" data-state={todo.status}>
                <Checkbox
                  readOnly
                  checked={todo.status === "completed"}
                  indeterminate={todo.status === "in_progress"}
                  label={todo.content}
                />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
