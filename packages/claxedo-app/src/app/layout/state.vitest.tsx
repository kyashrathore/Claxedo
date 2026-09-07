import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import type { LayoutPreset } from "./config"
import { createShellLayoutState } from "./state"

afterEach(cleanup)

// `state.test.ts` covers the pure command/state logic. This drives the accessor
// chain the app actually wires — `app-shell-layout.tsx`'s `sidebarWidth` derived
// from `config().regions.rail.size` and bound into a `--claxedo-sidebar-width`
// style var the way `rail-sidebar-shell.tsx` binds it — through a real Solid
// mount, so `size.value: 0` is proven to reach the DOM when `docked` flips.
describe("shell layout rail width reactivity (DOM)", () => {
  test("toggling a pinned rail propagates size 0 to the bound width style var and back", () => {
    let layout!: ReturnType<typeof createShellLayoutState>
    const { container } = render(() => {
      layout = createShellLayoutState({
        target: () => "web",
        preset: () => "claxedo.default",
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

  test("the navigator region's size reaches the bound width style var and follows the preset", () => {
    let layout!: ReturnType<typeof createShellLayoutState>
    const [preset, setPreset] = createSignal<LayoutPreset>("claxedo.navigator-sidebar")
    const { container } = render(() => {
      layout = createShellLayoutState({
        target: () => "web",
        preset,
        initialRail: { collapsed: false, pinned: true, width: 260 },
        initialWorkspacePanel: { open: false, width: 520 },
        initialNavigator: { width: 300 },
      })
      const navigatorRegion = () => layout.config().regions.navigator
      const navigatorWidth = () => (navigatorRegion()?.size.unit === "px" ? navigatorRegion().size.value : 320)
      return (
        <div
          data-testid="navigator"
          data-mounted={String(!!navigatorRegion())}
          style={{ "--claxedo-navigator-width": `${navigatorWidth()}px` }}
        />
      )
    })

    const navigator = container.querySelector('[data-testid="navigator"]') as HTMLElement
    expect(navigator.getAttribute("data-mounted")).toBe("true")
    expect(navigator.style.getPropertyValue("--claxedo-navigator-width")).toBe("300px")

    layout.setNavigatorWidth(420)
    expect(navigator.style.getPropertyValue("--claxedo-navigator-width")).toBe("420px")

    setPreset("claxedo.default")
    expect(navigator.getAttribute("data-mounted")).toBe("false")

    setPreset("claxedo.navigator-sidebar")
    expect(navigator.getAttribute("data-mounted")).toBe("true")
    expect(navigator.style.getPropertyValue("--claxedo-navigator-width")).toBe("420px")
  })
})
