import { untrack } from "solid-js"
import { persistedSignal, preferenceKey, tabStorage } from "@/lib/persisted"
import type { SessionView } from "@/session"
import { todoDockOpen } from "./model"

const readCollapsed = (value: unknown) => (typeof value === "boolean" ? value : undefined)

export type TodoDock = {
  readonly open: () => boolean
  readonly collapsed: () => boolean
  readonly toggle: () => void
}

export function createTodoDock(view: () => SessionView): TodoDock {
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
