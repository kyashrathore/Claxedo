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
        onNewTerminalDraft={() => undefined}
      />
    ))

    expect(screen.getByRole("button", { name: "New Session" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "New Terminal" })).toBeNull()
  })

  test("the terminal control opens the creator instead of starting a pty", () => {
    const onNewTerminalDraft = vi.fn()
    render(() => (
      <WorkspaceScopeButtons
        canUseTerminal
        onNewSession={() => undefined}
        onNewTerminalDraft={onNewTerminalDraft}
      />
    ))

    fireEvent.click(screen.getByRole("button", { name: "New Terminal" }))

    expect(onNewTerminalDraft).toHaveBeenCalledTimes(1)
  })

  /**
   * The header's directory is `sidebarDir() ?? focusedPaneWorkspaceDir()` — a
   * fallback chain rather than a choice — so no control here may start a process
   * in it directly. The per-agent shortcuts that used to live here are tiles in
   * the creator, which runs them only after a workspace has been picked.
   */
  test("offers no shortcut that starts an agent in the inferred directory", () => {
    render(() => (
      <WorkspaceScopeButtons
        canUseTerminal
        onNewSession={() => undefined}
        onNewTerminalDraft={() => undefined}
      />
    ))

    expect(screen.queryByRole("button", { name: "New Claude Terminal" })).toBeNull()
    expect(screen.queryByRole("button", { name: "New Codex Terminal" })).toBeNull()
  })
})
