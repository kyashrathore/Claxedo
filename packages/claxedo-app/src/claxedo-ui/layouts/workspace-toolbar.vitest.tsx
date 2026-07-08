import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { WorkspaceScopeButtons } from "./workspace-toolbar"

afterEach(() => cleanup())

describe("WorkspaceScopeButtons", () => {
  test("hides terminal controls when the focused session has no workspace backing", () => {
    render(() => (
      <WorkspaceScopeButtons
        canUseTerminal={false}
        onNewSession={() => undefined}
        onNewTerminal={() => undefined}
      />
    ))

    expect(screen.getByRole("button", { name: "New Session" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "New Claude Terminal" })).toBeNull()
    expect(screen.queryByRole("button", { name: "New Codex Terminal" })).toBeNull()
  })

  test("keeps terminal controls usable for workspace-backed sessions", () => {
    const onNewTerminal = vi.fn()
    render(() => (
      <WorkspaceScopeButtons
        canUseTerminal
        onNewSession={() => undefined}
        onNewTerminal={onNewTerminal}
      />
    ))

    fireEvent.click(screen.getByRole("button", { name: "New Claude Terminal" }))
    fireEvent.click(screen.getByRole("button", { name: "New Codex Terminal" }))

    expect(onNewTerminal).toHaveBeenCalledTimes(2)
    expect(onNewTerminal.mock.calls[0]?.[1]).toBe("Claude")
    expect(onNewTerminal.mock.calls[1]?.[1]).toBe("Codex")
  })
})
