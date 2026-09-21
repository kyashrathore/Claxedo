import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { BrowserPaneProvider, useBrowserPane, type BrowserPaneState } from "./browser-pane-context"

afterEach(cleanup)

function mountContext(): BrowserPaneState {
  let state!: BrowserPaneState
  render(() => (
    <BrowserPaneProvider paneId="pane-1" initialUrl="https://app.example.com/">
      {(() => {
        state = useBrowserPane()
        return null
      })()}
    </BrowserPaneProvider>
  ))
  return state
}

const node = { ok: true as const, selector: "#cta", frameUrl: "https://app.example.com/", tagName: "button" }

describe("browser pane navigation generation", () => {
  test("a pick is stamped with the generation current at pick time", () => {
    const ctx = mountContext()
    expect(ctx.navigationGeneration()).toBe(0)
    ctx.noteNavigation("load")
    ctx.noteNavigation("in-page")
    ctx.setLastSelectedNode(node)
    expect(ctx.lastSelectedNode()).toMatchObject({ selector: "#cta", navigationGeneration: 2 })
  })

  test("a full load bumps the generation, drops the pick, and disarms inspect", async () => {
    const ctx = mountContext()
    await ctx.setInspectMode(true)
    ctx.setLastSelectedNode(node)
    ctx.noteNavigation("load")
    expect(ctx.navigationGeneration()).toBe(1)
    expect(ctx.lastSelectedNode()).toBeUndefined()
    expect(ctx.inspectMode()).toBe(false)
  })

  test("an in-page navigation bumps the generation and drops the pick but keeps inspect armed", async () => {
    const ctx = mountContext()
    await ctx.setInspectMode(true)
    ctx.setLastSelectedNode(node)
    ctx.noteNavigation("in-page")
    expect(ctx.navigationGeneration()).toBe(1)
    expect(ctx.lastSelectedNode()).toBeUndefined()
    expect(ctx.inspectMode()).toBe(true)
  })
})
