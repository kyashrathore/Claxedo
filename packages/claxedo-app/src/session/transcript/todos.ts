import { createSignal, type Accessor } from "solid-js"
import type { Todo } from "@/server"

export type SessionTodosStore = {
  readonly list: Accessor<readonly Todo[]>
  readonly read: (todos: readonly Todo[], sentAt: number) => void
  readonly changed: (todos: readonly Todo[]) => void
}

type TodosFacts = { readonly todos: readonly Todo[]; readonly at: number; readonly source: "read" | "event" }

const NO_TODOS: TodosFacts = { todos: [], at: Number.NEGATIVE_INFINITY, source: "read" }

function todosRead(facts: TodosFacts, todos: readonly Todo[], sentAt: number): TodosFacts {
  if (facts.source === "event" ? facts.at >= sentAt : facts.at > sentAt) return facts
  return { todos, at: sentAt, source: "read" }
}

export function createSessionTodos(): SessionTodosStore {
  const [facts, setFacts] = createSignal<TodosFacts>(NO_TODOS)
  return {
    list: () => facts().todos,
    read: (todos, sentAt) => setFacts((current) => todosRead(current, todos, sentAt)),
    changed: (todos) => setFacts({ todos, at: Date.now(), source: "event" }),
  }
}
