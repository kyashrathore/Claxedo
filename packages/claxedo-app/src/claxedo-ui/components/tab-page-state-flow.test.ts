import { describe, expect, test } from "bun:test"
import {
  reduceOverlay,
  diffNodes,
  nodeSize,
  pickAiSelection,
  canRunAiMenuItem,
  actionNeedsSelection,
  AI_MENU_ITEMS,
  DIFF_DELETE_MARKS,
  DIFF_INSERT_MARKS,
  type OverlayState,
} from "./tab-page-utils"

const hasMarks = (nodes: ReturnType<typeof diffNodes>, marks: typeof DIFF_DELETE_MARKS) =>
  nodes.some((node) => node.type === "text" && JSON.stringify(node.marks || []) === JSON.stringify(marks))

describe("tab-page state flow", () => {
  test("selection -> toolbar -> ai menu -> preview -> dismiss -> hidden", () => {
    const point = { x: 120, y: 260 }
    const moved = { x: 120, y: 272 }
    const panel = { x: 120, y: 308, width: 540 }
    const draft = {
      text: "next text",
      selection: { from: 10, to: 22 },
      original: "old text",
      range: { from: 10, to: 26 },
      inline: true,
    }

    const s1 = reduceOverlay({ type: "hidden" }, { type: "SELECTION", pos: point })
    expect(s1).toEqual({ type: "toolbar", pos: point })

    const s2 = reduceOverlay(s1, { type: "TOGGLE_AI_MENU" })
    expect(s2).toEqual({ type: "ai_menu", pos: point })

    const s3 = reduceOverlay(s2, { type: "SELECTION", pos: moved })
    expect(s3).toEqual({ type: "ai_menu", pos: moved })

    const s4 = reduceOverlay(s3, { type: "AI_RESULT", pos: panel, draft })
    expect(s4).toEqual({ type: "ai_preview", pos: panel, draft })

    const s5 = reduceOverlay(s4, { type: "SELECTION", pos: null })
    expect(s5).toEqual(s4)

    const s6 = reduceOverlay(s5, { type: "HIDE_ALL" })
    expect(s6).toEqual(s4)

    const s7 = reduceOverlay(s6, { type: "DISMISS_PREVIEW" })
    expect(s7).toEqual({ type: "hidden" })
  })

  test("preview clear returns to hidden and next selection reopens toolbar", () => {
    const panel = { x: 100, y: 200, width: 500 }
    const draft = {
      text: "updated",
      selection: { from: 1, to: 8 },
      original: "original",
      range: { from: 1, to: 12 },
      inline: true,
    }

    const p = reduceOverlay({ type: "toolbar", pos: { x: 100, y: 160 } }, { type: "AI_RESULT", pos: panel, draft })
    const h = reduceOverlay(p, { type: "CLEAR_PREVIEW" })
    expect(h).toEqual({ type: "hidden" })

    const back = reduceOverlay(h, { type: "SELECTION", pos: { x: 90, y: 150 } })
    expect(back).toEqual({ type: "toolbar", pos: { x: 90, y: 150 } })
  })
})

describe("tab-page ai selection flow", () => {
  const improve = AI_MENU_ITEMS.find((item) => item.key === "improve")!
  const continueItem = AI_MENU_ITEMS.find((item) => item.key === "continue")!

  test("cached selection keeps AI actions runnable after focus leaves editor", () => {
    const live = { from: 18, to: 36 }
    const cached = { from: 40, to: 55 }
    const selected = pickAiSelection(live, cached, 120)
    expect(selected).toEqual({ from: 18, to: 36 })

    const afterBlur = pickAiSelection(null, selected, 120)
    expect(afterBlur).toEqual({ from: 18, to: 36 })

    expect(canRunAiMenuItem(improve, false, true)).toBe(true)
    expect(canRunAiMenuItem(improve, false, false)).toBe(false)
    expect(canRunAiMenuItem(continueItem, false, false)).toBe(true)
  })

  test("action selection policy matches expected editing behavior", () => {
    expect(actionNeedsSelection("improve")).toBe(true)
    expect(actionNeedsSelection("fix")).toBe(true)
    expect(actionNeedsSelection("shorten")).toBe(true)
    expect(actionNeedsSelection("lengthen")).toBe(true)
    expect(actionNeedsSelection("continue")).toBe(false)
    expect(actionNeedsSelection("summarize")).toBe(false)
    expect(actionNeedsSelection("custom")).toBe(false)
  })
})

describe("tab-page diff preview flow", () => {
  test("streamed partial previews keep delete marks and finish with insert marks", () => {
    const oldText = "Many features here are powered by open-source Tiptap UI Components."
    const nextText = "Many features use open-source Tiptap UI Components."
    const stepA = nextText.slice(0, Math.floor(nextText.length * 0.33))
    const stepB = nextText.slice(0, Math.floor(nextText.length * 0.66))
    const stepC = nextText

    const initial = diffNodes(oldText, "")
    const partA = diffNodes(oldText, stepA)
    const partB = diffNodes(oldText, stepB)
    const partC = diffNodes(oldText, stepC)

    expect(hasMarks(initial, DIFF_DELETE_MARKS)).toBe(true)
    expect(hasMarks(partA, DIFF_DELETE_MARKS)).toBe(true)
    expect(hasMarks(partB, DIFF_DELETE_MARKS)).toBe(true)
    expect(hasMarks(partC, DIFF_INSERT_MARKS)).toBe(true)

    expect(nodeSize(initial)).toBeGreaterThan(0)
    expect(nodeSize(partA)).toBeGreaterThan(0)
    expect(nodeSize(partB)).toBeGreaterThan(0)
    expect(nodeSize(partC)).toBeGreaterThan(0)
  })

  test("preview lifecycle transitions do not lose ai_preview until explicit clear/dismiss", () => {
    const draft = {
      text: "new line",
      selection: { from: 6, to: 14 },
      original: "old line",
      range: { from: 6, to: 16 },
      inline: true,
    }
    const panel = { x: 80, y: 220, width: 460 }
    const preview = reduceOverlay({ type: "ai_menu", pos: { x: 80, y: 180 } }, { type: "AI_RESULT", pos: panel, draft })
    expect((preview).type).toBe("ai_preview")

    const stillPreview = reduceOverlay(preview, { type: "HIDE_ALL" })
    expect(stillPreview).toEqual(preview)

    const hidden = reduceOverlay(stillPreview, { type: "CLEAR_PREVIEW" })
    expect(hidden).toEqual({ type: "hidden" })
  })
})
