import { describe, expect, test } from "bun:test"
import { MERMAID_PAN_STEP, MERMAID_ZOOM_IN_FACTOR, MERMAID_ZOOM_OUT_FACTOR, mermaidKeyAction } from "./mermaid-keyboard"

// The keyboard-only contract for the mermaid pan/zoom viewport.

describe("mermaidKeyAction", () => {
  test("zoom factors bracket 1: in enlarges, out shrinks", () => {
    expect(MERMAID_ZOOM_IN_FACTOR).toBeGreaterThan(1)
    expect(MERMAID_ZOOM_OUT_FACTOR).toBeLessThan(1)
  })

  test("'+' and '=' zoom in", () => {
    expect(mermaidKeyAction("+")).toEqual({ type: "zoom", factor: MERMAID_ZOOM_IN_FACTOR })
    expect(mermaidKeyAction("=")).toEqual({ type: "zoom", factor: MERMAID_ZOOM_IN_FACTOR })
  })

  test("'-' and '_' zoom out", () => {
    expect(mermaidKeyAction("-")).toEqual({ type: "zoom", factor: MERMAID_ZOOM_OUT_FACTOR })
    expect(mermaidKeyAction("_")).toEqual({ type: "zoom", factor: MERMAID_ZOOM_OUT_FACTOR })
  })

  test("'0' resets the view", () => {
    expect(mermaidKeyAction("0")).toEqual({ type: "reset" })
  })

  test("arrow keys pan by the step in the arrow's direction", () => {
    expect(mermaidKeyAction("ArrowUp")).toEqual({ type: "pan", dx: 0, dy: MERMAID_PAN_STEP })
    expect(mermaidKeyAction("ArrowDown")).toEqual({ type: "pan", dx: 0, dy: -MERMAID_PAN_STEP })
    expect(mermaidKeyAction("ArrowLeft")).toEqual({ type: "pan", dx: MERMAID_PAN_STEP, dy: 0 })
    expect(mermaidKeyAction("ArrowRight")).toEqual({ type: "pan", dx: -MERMAID_PAN_STEP, dy: 0 })
  })

  test("honors a custom pan step", () => {
    expect(mermaidKeyAction("ArrowLeft", 10)).toEqual({ type: "pan", dx: 10, dy: 0 })
  })

  test("returns null for keys that are not mermaid controls", () => {
    expect(mermaidKeyAction("a")).toBeNull()
    expect(mermaidKeyAction("Enter")).toBeNull()
    expect(mermaidKeyAction("Tab")).toBeNull()
  })
})
