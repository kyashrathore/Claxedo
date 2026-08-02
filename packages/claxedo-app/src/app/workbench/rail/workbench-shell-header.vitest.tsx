import { render, screen } from "@solidjs/testing-library"
import { createComponent } from "solid-js"
import { describe, expect, test } from "vitest"
import { WorkspacePanelChrome } from "./workbench-shell-header"

describe("WorkspacePanelChrome", () => {
  const base = {
    workspacePanelOpen: () => false,
    workspacePanelFullWidth: () => false,
    allowFullWidth: false,
    onToggleFullWidth: () => {},
    onTogglePanel: () => {},
  }

  test("keeps the workspace toggle neutral while context is presented in the active surface", () => {
    render(() => createComponent(WorkspacePanelChrome, base))

    const toggle = screen.getByRole("button", { name: "Open workspace panel" })
    expect(toggle).toHaveAttribute("data-icon-interaction", "binary")
    expect(toggle).toHaveAttribute("aria-pressed", "false")
    expect(toggle.querySelector('[data-icon="layout-right-partial"]')).toBeTruthy()
    expect(screen.queryByTestId("workspace-panel-toggle-attention")).toBeNull()
  })

  test("uses the selected right-panel glyph while the workspace panel is open", () => {
    render(() => createComponent(WorkspacePanelChrome, { ...base, workspacePanelOpen: () => true }))

    const toggle = screen.getByRole("button", { name: "Close workspace panel" })
    expect(toggle).toHaveAttribute("data-icon-interaction", "binary")
    expect(toggle).toHaveAttribute("aria-pressed", "true")
    expect(toggle.querySelector('[data-icon="layout-right-full"]')).toBeTruthy()
  })

  test("treats workspace width as a dim-off and bright-on binary state", () => {
    const view = render(() =>
      createComponent(WorkspacePanelChrome, {
        ...base,
        allowFullWidth: true,
        workspacePanelOpen: () => true,
      }),
    )

    const maximize = screen.getByRole("button", { name: "Maximize workspace panel" })
    expect(maximize).toHaveAttribute("data-icon-interaction", "binary")
    expect(maximize).toHaveAttribute("aria-pressed", "false")
    expect(maximize.querySelector('[data-icon="expand"]')).toBeTruthy()

    view.unmount()
    render(() =>
      createComponent(WorkspacePanelChrome, {
        ...base,
        allowFullWidth: true,
        workspacePanelOpen: () => true,
        workspacePanelFullWidth: () => true,
      }),
    )

    const restore = screen.getByRole("button", { name: "Restore workspace panel width" })
    expect(restore).toHaveAttribute("data-icon-interaction", "binary")
    expect(restore).toHaveAttribute("aria-pressed", "true")
    expect(restore.querySelector('[data-icon="collapse"]')).toBeTruthy()
  })
})
