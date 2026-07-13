import { render, screen } from "@solidjs/testing-library"
import { createComponent } from "solid-js"
import { describe, expect, test } from "vitest"
import { WorkspacePanelChrome } from "./workbench-shell-header"

describe("WorkspacePanelChrome attention", () => {
  const base = {
    workspacePanelOpen: () => false,
    workspacePanelFullWidth: () => false,
    allowFullWidth: false,
    onToggleFullWidth: () => {},
    onTogglePanel: () => {},
  }

  test("keeps the plain toggle name and shows no dot when there is no attention", () => {
    render(() => createComponent(WorkspacePanelChrome, { ...base, attention: () => false }))

    expect(screen.getByRole("button", { name: "Open workspace panel" })).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-panel-toggle-attention")).toBeNull()
  })

  test("exposes attention in the toggle's accessible name while preserving the dot and the visible title", () => {
    render(() => createComponent(WorkspacePanelChrome, { ...base, attention: () => true }))

    const button = screen.getByRole("button", { name: "Open workspace panel, needs attention" })
    expect(button).toBeInTheDocument()
    // Visible tooltip copy is unchanged; attention is exposed only to assistive technology.
    expect(button).toHaveAttribute("title", "Open workspace panel")
    // The same attention dot still renders.
    expect(screen.getByTestId("workspace-panel-toggle-attention")).toBeInTheDocument()
  })
})
