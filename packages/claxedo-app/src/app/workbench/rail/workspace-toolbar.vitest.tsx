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
   * Marketplace and Global chat are exactly where "which workspace?" is most
   * worth asking, so the terminal control is not gated on the focused surface
   * having one — having no workspace is what the creator is for, not a reason
   * to withhold the way to open it.
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


  test("hides document actions when the shell withholds their callbacks", async () => {
    render(() => (
      <WorkspaceScopeButtons
        canUseDocuments
        onNewSession={() => undefined}
      />
    ))

    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull()

    cleanup()
    render(() => (
      <WorkspaceScopeButtons
        canUseDocuments
        onNewSession={() => undefined}
        onNewPage={() => undefined}
      />
    ))

    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "ArrowDown" })
    expect(await screen.findByRole("menuitem", { name: "New Document" })).toBeInTheDocument()
  })

  /**
   * Settings is the account menu's, and terminal commands are reached through
   * it — so with documents off there is no entry left and no trigger to open.
   */
  test("drops the more menu when the document action is withheld", () => {
    render(() => (
      <WorkspaceScopeButtons
        canCreateTerminal
        onNewSession={() => undefined}
        onNewTerminalDraft={() => undefined}
      />
    ))

    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull()
  })

  /**
   * The header's directory is `sidebarDir() ?? focusedPaneWorkspaceDir()` — a
   * fallback chain rather than a choice — so no control here may start a
   * process in it directly. Per-agent shortcuts live in the creator instead,
   * as tiles it runs only after a workspace has been picked.
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
