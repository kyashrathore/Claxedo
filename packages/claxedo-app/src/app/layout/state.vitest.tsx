import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import { createShellLayoutState } from "./state"

afterEach(cleanup)

// Regression coverage for the "sidebar-toggle collapses the rail's width"
// investigation (e2e core-sidebar-tree behavior 13). The pure command/state
// logic is covered by state.test.ts; this drives the SAME accessor chain the
// app wires — app-shell-layout.tsx's `sidebarWidth` derived from
// `config().regions.rail.size`, bound into a `--claxedo-sidebar-width` style
// var the way rail-sidebar-shell.tsx binds it — through a real Solid mount, to
// prove `size.value: 0` actually propagates to the DOM when `docked` flips.
describe("shell layout rail width reactivity (DOM)", () => {
  test("toggling a pinned rail propagates size 0 to the bound width style var and back", () => {
    let layout!: ReturnType<typeof createShellLayoutState>
    const { container } = render(() => {
      layout = createShellLayoutState({
        target: () => "web",
        initialRail: { collapsed: false, pinned: true, width: 260 },
        initialWorkspacePanel: { open: false, width: 520 },
      })
      const railRegion = () => layout.config().regions.rail
      const sidebarWidth = () => (railRegion().size.unit === "px" ? railRegion().size.value : 260)
      const sidebarPinned = () => railRegion().docked !== false
      return (
        <div
          data-testid="rail"
          data-pinned={String(sidebarPinned())}
          style={{ "--claxedo-sidebar-width": `${sidebarWidth()}px` }}
        />
      )
    })

    const rail = container.querySelector('[data-testid="rail"]') as HTMLElement
    expect(rail.style.getPropertyValue("--claxedo-sidebar-width")).toBe("260px")
    expect(rail.getAttribute("data-pinned")).toBe("true")

    layout.toggleRail()
    // `docked` and `size` come from ONE region.update command, so both must
    // update together — the width must not freeze while pinned flips.
    expect(rail.getAttribute("data-pinned")).toBe("false")
    expect(rail.style.getPropertyValue("--claxedo-sidebar-width")).toBe("0px")

    layout.toggleRail()
    expect(rail.getAttribute("data-pinned")).toBe("true")
    expect(rail.style.getPropertyValue("--claxedo-sidebar-width")).toBe("260px")
  })
})
