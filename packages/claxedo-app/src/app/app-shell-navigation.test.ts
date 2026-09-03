import { describe, expect, test } from "bun:test"
import { resolveAppShellNavigationActions } from "./app-shell-navigation"

describe("app shell product navigation", () => {
  const onNewPage = () => undefined

  test("removes rail and header actions when flags are omitted", () => {
    expect(resolveAppShellNavigationActions({ onNewPage })).toEqual({ onNewPage: undefined })
  })

  test("enables Documents when its flag is set", () => {
    expect(resolveAppShellNavigationActions({ documentNavigationEnabled: true, onNewPage })).toEqual({ onNewPage })
  })
})
