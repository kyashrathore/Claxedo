import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { WorkspaceToolButtons } from "./workspace-tool-buttons"
import { SEMANTIC_ICON, type SemanticIconConcept } from "@/ui/semantic-icon"
import { codexIconLibrary } from "@/ui/icons/codex"

afterEach(() => cleanup())

const spriteHref = (concept: SemanticIconConcept) =>
  `#codex-icon-sprite-${codexIconLibrary.resolve(SEMANTIC_ICON[concept])}`

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

    // Which concept each button draws, not which artwork the library currently
    // maps it to — a re-pointed glyph is an icon-library decision, while a
    // button reaching for the wrong concept is this component's regression.
    // The literal `codex-icon-sprite-` prefix is the lazy inline sprite's
    // namespace: symbol ids carry the sprite id once the sheet is inlined, so
    // hrefs resolve against the inlined copy rather than the fetch URL.
    expect(files.querySelector("use")?.getAttribute("href")).toBe(spriteHref("files"))
    expect(changes.querySelector("use")?.getAttribute("href")).toBe(spriteHref("changes"))
    expect(processes.querySelector("use")?.getAttribute("href")).toBe(spriteHref("processes"))
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
