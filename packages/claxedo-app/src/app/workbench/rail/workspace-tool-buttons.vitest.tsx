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

    const files = screen.getByRole("button", { name: "Open Files" })
    const changes = screen.getByRole("button", { name: "Close Changes" })
    const processes = screen.getByRole("button", { name: "Open Processes" })

    expect(files.querySelector("use")?.getAttribute("href")).toMatch(/#codex-20-057$/)
    // The boxed ±, shared with `review` — see the note on the `changes` entry in
    // `@/ui/icons/codex`. It was codex-20-120 until 5197e0704 re-pointed it.
    expect(changes.querySelector("use")?.getAttribute("href")).toMatch(/#codex-20-071$/)
    expect(processes.querySelector("use")?.getAttribute("href")).toMatch(/#codex-20-050$/)
    expect(files.className).toContain("!size-3.5")
    expect(files).toHaveAttribute("data-icon-interaction", "binary")
    expect(files).toHaveAttribute("aria-pressed", "false")
    expect(changes).toHaveAttribute("data-icon-interaction", "binary")
    expect(changes).toHaveAttribute("aria-pressed", "true")
    expect(changes.className).not.toContain("bg-surface-base-active")
    expect(processes).toHaveAttribute("aria-pressed", "false")

    fireEvent.click(files)
    fireEvent.click(changes)
    fireEvent.click(processes)

    expect(onToggle).toHaveBeenNthCalledWith(1, "files")
    expect(onToggle).toHaveBeenNthCalledWith(2, "changes")
    expect(onToggle).toHaveBeenNthCalledWith(3, "processes")
  })
})
