import { describe, expect, test } from "bun:test"
import { resolveAppShellNavigationActions } from "./app-shell-navigation"

describe("app shell product navigation", () => {
  const onNewPage = () => undefined
  const onNewTask = () => undefined
  const onOpenWorkGraph = () => undefined

  test("removes rail and header actions when flags are omitted", () => {
    expect(resolveAppShellNavigationActions({ onNewPage, onNewTask, onOpenWorkGraph })).toEqual({
      onNewPage: undefined,
      onNewTask: undefined,
      onOpenWorkGraph: undefined,
    })
  })

  test("enables Documents independently", () => {
    expect(resolveAppShellNavigationActions({
      documentNavigationEnabled: true,
      onNewPage,
      onNewTask,
      onOpenWorkGraph,
    })).toEqual({ onNewPage, onNewTask: undefined, onOpenWorkGraph: undefined })
  })

  test("enables both WorkGraph entry points together", () => {
    expect(resolveAppShellNavigationActions({
      workGraphNavigationEnabled: true,
      onNewPage,
      onNewTask,
      onOpenWorkGraph,
    })).toEqual({ onNewPage: undefined, onNewTask, onOpenWorkGraph })
  })
})
