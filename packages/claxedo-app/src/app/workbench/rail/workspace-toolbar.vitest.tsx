import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { WorkspaceScopeButtons } from "./workspace-toolbar"

afterEach(() => cleanup())

describe("WorkspaceScopeButtons", () => {
  test("hides the terminal control only when the role forbids terminals", () => {
    render(() => (
      <WorkspaceScopeButtons
        canCreateTerminal={false}
        onNewSession={() => undefined}
        onNewTerminalDraft={() => undefined}
      />
    ))

    expect(screen.getByRole("button", { name: "New Session" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "New Terminal" })).toBeNull()
  })

  /**
   * Regression: the control used to be gated on the focused surface having a
   * workspace, which hid it on WorkGraph, Marketplace and Global chat — the
   * surfaces where "which workspace?" is most worth asking. Having no workspace
   * is what the creator is for, not a reason to withhold the way to open it.
   */
  test("keeps the terminal control on global surfaces that have no workspace", () => {
    const onNewTerminalDraft = vi.fn()
    render(() => (
      <WorkspaceScopeButtons
        global
        onNewSession={() => undefined}
        onNewTerminalDraft={onNewTerminalDraft}
      />
    ))

    fireEvent.click(screen.getByRole("button", { name: "New Terminal" }))
    expect(onNewTerminalDraft).toHaveBeenCalledTimes(1)
  })

  test("the terminal control opens the creator instead of starting a pty", () => {
    const onNewTerminalDraft = vi.fn()
    render(() => (
      <WorkspaceScopeButtons
        canCreateTerminal
        onNewSession={() => undefined}
        onNewTerminalDraft={onNewTerminalDraft}
      />
    ))

    fireEvent.click(screen.getByRole("button", { name: "New Terminal" }))

    expect(onNewTerminalDraft).toHaveBeenCalledTimes(1)
  })

  test("offers a task composer on workspace and global surfaces", () => {
    const onNewTask = vi.fn()
    render(() => (
      <WorkspaceScopeButtons
        global
        onNewSession={() => undefined}
        onNewTask={onNewTask}
      />
    ))

    fireEvent.click(screen.getByRole("button", { name: "New task" }))
    expect(onNewTask).toHaveBeenCalledTimes(1)
  })

  test("hides task and document actions when the shell withholds their callbacks", async () => {
    render(() => (
      <WorkspaceScopeButtons
        canUseDocuments
        onNewSession={() => undefined}
      />
    ))

    expect(screen.queryByRole("button", { name: "New task" })).toBeNull()
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "ArrowDown" })
    expect(screen.queryByRole("menuitem", { name: "New Document" })).toBeNull()

    cleanup()
    render(() => (
      <WorkspaceScopeButtons
        onNewSession={() => undefined}
        onNewTask={() => undefined}
      />
    ))

    expect(screen.getByRole("button", { name: "New task" })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "ArrowDown" })
    expect(screen.queryByRole("menuitem", { name: "New Document" })).toBeNull()

    cleanup()
    render(() => (
      <WorkspaceScopeButtons
        canUseDocuments
        onNewSession={() => undefined}
        onNewPage={() => undefined}
      />
    ))

    expect(screen.queryByRole("button", { name: "New task" })).toBeNull()
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "ArrowDown" })
    expect(await screen.findByRole("menuitem", { name: "New Document" })).toBeInTheDocument()
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
        canCreateTerminal
        onNewSession={() => undefined}
        onNewTerminalDraft={() => undefined}
      />
    ))

    expect(screen.queryByRole("button", { name: "New Claude Terminal" })).toBeNull()
    expect(screen.queryByRole("button", { name: "New Codex Terminal" })).toBeNull()
  })
})
