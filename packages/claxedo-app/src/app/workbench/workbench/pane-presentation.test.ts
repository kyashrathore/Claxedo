import { describe, expect, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import {
  PanePresentationProvider,
  resolvePanePresentation,
  usePanePresentation,
  type PanePresentationResolver,
} from "./pane-presentation"

describe("usePanePresentation", () => {
  test("resolves every pane as docked when no provider is mounted", () => {
    createRoot((dispose) => {
      const resolver = usePanePresentation()
      expect(resolver.presentationFor("pane-1")).toBe("docked")
      expect(resolver.presentationFor("")).toBe("docked")
      dispose()
    })
  })

  test("returns the resolver a provider supplies", () => {
    const provided: PanePresentationResolver = {
      presentationFor: (paneId) => (paneId === "pane-covered" ? "floating" : "docked"),
    }
    createRoot((dispose) => {
      let seen: PanePresentationResolver | undefined
      createComponent(PanePresentationProvider, {
        value: provided,
        get children() {
          seen = usePanePresentation()
          return undefined
        },
      })
      expect(seen).toBe(provided)
      expect(seen?.presentationFor("pane-covered")).toBe("floating")
      expect(seen?.presentationFor("pane-other")).toBe("docked")
      dispose()
    })
  })
})

const covered = { panelOpen: true, panelFullWidth: true, contentFloats: true }

describe("resolvePanePresentation", () => {
  test("the targeted session pane floats only while the panel covers the column at full view", () => {
    expect(resolvePanePresentation({ ...covered, paneId: "p1", targetPaneId: "p1", focusedPaneId: "p1" })).toBe("floating")
    expect(resolvePanePresentation({ ...covered, panelOpen: false, paneId: "p1", targetPaneId: "p1", focusedPaneId: "p1" })).toBe("docked")
    expect(resolvePanePresentation({ ...covered, panelFullWidth: false, paneId: "p1", targetPaneId: "p1", focusedPaneId: "p1" })).toBe("docked")
  })

  test("a targetless panel attaches to the focused pane", () => {
    expect(resolvePanePresentation({ ...covered, paneId: "p1", targetPaneId: undefined, focusedPaneId: "p1" })).toBe("floating")
    expect(resolvePanePresentation({ ...covered, paneId: "p2", targetPaneId: undefined, focusedPaneId: "p1" })).toBe("docked")
    expect(resolvePanePresentation({ ...covered, paneId: "p1", targetPaneId: undefined, focusedPaneId: null })).toBe("docked")
  })

  test("a targeted pane whose content has no floating layout stays docked, so it hides under the panel", () => {
    expect(resolvePanePresentation({ ...covered, contentFloats: false, paneId: "p1", targetPaneId: "p1", focusedPaneId: "p1" })).toBe("docked")
    expect(resolvePanePresentation({ ...covered, contentFloats: false, paneId: "p1", targetPaneId: undefined, focusedPaneId: "p1" })).toBe("docked")
  })
})
