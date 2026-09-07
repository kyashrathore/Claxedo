import { describe, expect, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { PanePresentationProvider, usePanePresentation, type PanePresentationResolver } from "./pane-presentation"

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
