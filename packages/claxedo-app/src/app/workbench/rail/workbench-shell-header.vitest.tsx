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

    expect(screen.getByRole("button", { name: "Open workspace panel" })).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-panel-toggle-attention")).toBeNull()
  })
})
