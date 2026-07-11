import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { WorkspaceToolButtons } from "./workspace-tool-buttons"

afterEach(() => cleanup())

describe("WorkspaceToolButtons", () => {
  test("hides files, changes, and processes when workspace tools are unavailable", () => {
    render(() => (
      <WorkspaceToolButtons
        available={false}
        filesActive={false}
        changesActive={false}
        processesActive={false}
        showChanges
        showProcesses
        onToggle={() => undefined}
      />
    ))

    expect(screen.queryByRole("button", { name: "Open Files" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Open Changes" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Open Processes" })).toBeNull()
  })

  test("shows workspace-backed files, changes, and processes controls", () => {
    const onToggle = vi.fn()
    render(() => (
      <WorkspaceToolButtons
        available
        filesActive={false}
        changesActive
        processesActive={false}
        showChanges
        showProcesses
        onToggle={onToggle}
      />
    ))

    expect(screen.getByRole("button", { name: "Open Files" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Close Changes" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Open Processes" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Open Files" }))
    fireEvent.click(screen.getByRole("button", { name: "Close Changes" }))
    fireEvent.click(screen.getByRole("button", { name: "Open Processes" }))

    expect(onToggle).toHaveBeenNthCalledWith(1, "files")
    expect(onToggle).toHaveBeenNthCalledWith(2, "changes")
    expect(onToggle).toHaveBeenNthCalledWith(3, "processes")
  })
})
