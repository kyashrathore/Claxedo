import { describe, expect, test } from "bun:test"
import {
  reduceOverlay,
  tokenizeWordDiff,
  tokenizeCharDiff,
  pushDiff,
  buildParts,
  equalChars,
  buildDiff,
  pushTextNodes,
  diffNodes,
  plainNodes,
  blockNodes,
  nodeSize,
  normalizeInstruction,
  getTopLevelAt,
  handleScopedSelectAll,
  clampSelection,
  pickAiSelection,
  canRunAiMenuItem,
  actionNeedsSelection,
  calcAnchoredPopover,
  DIFF_DELETE_MARKS,
  DIFF_INSERT_MARKS,
  CONVERT_MENU_ITEMS,
  AI_MENU_ITEMS,
} from "./tab-page-utils"
import type { OverlayState, DiffPart, InlineNode } from "./tab-page-utils"

// ── Helpers ────────────────────────────────────────────────────────────

const hidden: OverlayState = { type: "hidden" }
const toolbar: OverlayState = { type: "toolbar", pos: { x: 10, y: 20 } }
const aiMenu: OverlayState = { type: "ai_menu", pos: { x: 10, y: 20 } }
const makeDraft = (text = "result") => ({
  text,
  selection: null,
  original: "original",
  range: null,
  inline: false,
})
const aiPreview: OverlayState = {
  type: "ai_preview",
  pos: { x: 10, y: 20, width: 300 },
  draft: makeDraft(),
}

// ── Overlay state machine ──────────────────────────────────────────────

describe("reduceOverlay", () => {
  test("HIDE_ALL from toolbar -> hidden", () => {
    const next = reduceOverlay(toolbar, { type: "HIDE_ALL" })
    expect(next).toEqual(hidden)
  })

  test("HIDE_ALL from ai_preview -> stays (preview immune)", () => {
    const next = reduceOverlay(aiPreview, { type: "HIDE_ALL" })
    expect(next).toBe(aiPreview)
  })

  test("DISMISS_PREVIEW from ai_preview -> hidden", () => {
    const next = reduceOverlay(aiPreview, { type: "DISMISS_PREVIEW" })
    expect(next).toEqual(hidden)
  })

  test("DISMISS_PREVIEW from toolbar -> no change", () => {
    const next = reduceOverlay(toolbar, { type: "DISMISS_PREVIEW" })
    expect(next).toBe(toolbar)
  })

  test("CLEAR_PREVIEW from ai_preview -> hidden", () => {
    const next = reduceOverlay(aiPreview, { type: "CLEAR_PREVIEW" })
    expect(next).toEqual(hidden)
  })

  test("TOGGLE_AI_MENU from toolbar -> ai_menu (same pos)", () => {
    const next = reduceOverlay(toolbar, { type: "TOGGLE_AI_MENU" })
    expect(next).toEqual({ type: "ai_menu", pos: { x: 10, y: 20 } })
  })

  test("TOGGLE_AI_MENU from ai_menu -> toolbar (same pos)", () => {
    const next = reduceOverlay(aiMenu, { type: "TOGGLE_AI_MENU" })
    expect(next).toEqual({ type: "toolbar", pos: { x: 10, y: 20 } })
  })

  test("TOGGLE_AI_MENU from hidden -> no change (stays hidden)", () => {
    const next = reduceOverlay(hidden, { type: "TOGGLE_AI_MENU" })
    expect(next).toBe(hidden)
  })

  test("AI_RESULT -> ai_preview with draft", () => {
    const draft = makeDraft("hello")
    const pos = { x: 5, y: 5, width: 200 }
    const next = reduceOverlay(toolbar, { type: "AI_RESULT", pos, draft })
    expect(next).toEqual({ type: "ai_preview", pos, draft })
  })

  test("SELECTION with pos from hidden -> toolbar", () => {
    const pos = { x: 50, y: 60 }
    const next = reduceOverlay(hidden, { type: "SELECTION", pos })
    expect(next).toEqual({ type: "toolbar", pos })
  })

  test("SELECTION with null from toolbar -> hidden", () => {
    const next = reduceOverlay(toolbar, { type: "SELECTION", pos: null })
    expect(next).toEqual(hidden)
  })

  test("SELECTION with null from ai_preview -> stays (preview immune)", () => {
    const next = reduceOverlay(aiPreview, { type: "SELECTION", pos: null })
    expect(next).toBe(aiPreview)
  })

  test("SELECTION with pos from ai_menu -> updates pos in ai_menu", () => {
    const pos = { x: 77, y: 88 }
    const next = reduceOverlay(aiMenu, { type: "SELECTION", pos })
    expect(next).toEqual({ type: "ai_menu", pos })
  })
})

// ── Diff algorithm ─────────────────────────────────────────────────────

describe("diff algorithm", () => {
  describe("tokenizeWordDiff", () => {
    test("splits words, spaces, and punctuation separately", () => {
      expect(tokenizeWordDiff("hello world")).toEqual(["hello", " ", "world"])
      expect(tokenizeWordDiff("a, b")).toEqual(["a", ",", " ", "b"])
    })

    test("handles unicode word boundaries", () => {
      expect(tokenizeWordDiff("café naïve")).toEqual(["café", " ", "naïve"])
    })

    test("empty string returns empty array", () => {
      expect(tokenizeWordDiff("")).toEqual([])
    })
  })

  describe("tokenizeCharDiff", () => {
    test("handles emoji / multi-codepoint", () => {
      const tokens = tokenizeCharDiff("\u{1F600}\u{1F60A}")
      expect(tokens).toEqual(["\u{1F600}", "\u{1F60A}"])
    })
  })

  describe("pushDiff", () => {
    test("same-kind parts merge instead of creating new entry", () => {
      const list: DiffPart[] = [{ kind: "insert", text: "a" }]
      pushDiff(list, "insert", "b")
      expect(list).toEqual([{ kind: "insert", text: "ab" }])
    })

    test("empty text is no-op", () => {
      const list: DiffPart[] = [{ kind: "equal", text: "x" }]
      pushDiff(list, "delete", "")
      expect(list).toEqual([{ kind: "equal", text: "x" }])
    })
  })

  describe("buildParts", () => {
    test("identical arrays -> all equal", () => {
      const parts = buildParts(["a", "b", "c"], ["a", "b", "c"])
      expect(parts).toEqual([{ kind: "equal", text: "abc" }])
    })

    test("completely different -> all delete + insert", () => {
      const parts = buildParts(["x"], ["y"])
      expect(parts).toEqual([
        { kind: "delete", text: "x" },
        { kind: "insert", text: "y" },
      ])
    })

    test("partial overlap preserves common subsequence", () => {
      const parts = buildParts(["a", "b", "c"], ["a", "c"])
      expect(parts).toEqual([
        { kind: "equal", text: "a" },
        { kind: "delete", text: "b" },
        { kind: "equal", text: "c" },
      ])
    })

    test("trailing elements in a produce deletes", () => {
      const parts = buildParts(["a", "b", "c", "d"], ["a"])
      expect(parts).toEqual([
        { kind: "equal", text: "a" },
        { kind: "delete", text: "bcd" },
      ])
    })
  })

  describe("equalChars", () => {
    test("counts only equal parts", () => {
      const parts: DiffPart[] = [
        { kind: "equal", text: "abc" },
        { kind: "delete", text: "xx" },
        { kind: "equal", text: "de" },
      ]
      expect(equalChars(parts)).toBe(5)
    })
  })

  describe("buildDiff", () => {
    test("identical strings -> single equal part", () => {
      expect(buildDiff("hello", "hello")).toEqual([{ kind: "equal", text: "hello" }])
    })

    test("small diff prefers char tokenization when it scores better", () => {
      const parts = buildDiff("ab", "ac")
      expect(parts).toEqual([
        { kind: "equal", text: "a" },
        { kind: "delete", text: "b" },
        { kind: "insert", text: "c" },
      ])
    })

    test("large diff (>700 chars) always uses word tokenization", () => {
      const oldText = "word ".repeat(200).trim()
      const newText = "word ".repeat(200).trim().replace(/word/g, "changed")
      const parts = buildDiff(oldText, newText)
      // Word-level tokens preserve spaces as equal parts
      const hasSpaceEqual = parts.some((p) => p.kind === "equal" && p.text.includes(" "))
      expect(hasSpaceEqual).toBe(true)
    })

    test("completely different text produces all delete + insert", () => {
      const parts = buildDiff("abc", "xyz")
      const deleteText = parts.filter((p) => p.kind === "delete").map((p) => p.text).join("")
      const insertText = parts.filter((p) => p.kind === "insert").map((p) => p.text).join("")
      expect(deleteText).toBe("abc")
      expect(insertText).toBe("xyz")
    })
  })
})

// ── Node builders ──────────────────────────────────────────────────────

describe("node builders", () => {
  describe("pushTextNodes", () => {
    test("multi-line inserts hardBreaks between lines", () => {
      const nodes: InlineNode[] = []
      pushTextNodes(nodes, "a\nb\nc")
      expect(nodes).toEqual([
        { type: "text", text: "a" },
        { type: "hardBreak" },
        { type: "text", text: "b" },
        { type: "hardBreak" },
        { type: "text", text: "c" },
      ])
    })

    test("marks are attached to text nodes but not hardBreaks", () => {
      const nodes: InlineNode[] = []
      pushTextNodes(nodes, "a\nb", [{ type: "bold" }])
      expect(nodes).toEqual([
        { type: "text", text: "a", marks: [{ type: "bold" }] },
        { type: "hardBreak" },
        { type: "text", text: "b", marks: [{ type: "bold" }] },
      ])
    })
  })

  describe("diffNodes", () => {
    test("produces strikethrough delete marks and green insert marks", () => {
      const nodes = diffNodes("old", "new")
      const hasDelete = nodes.some(
        (n) => n.type === "text" && n.marks && JSON.stringify(n.marks) === JSON.stringify(DIFF_DELETE_MARKS),
      )
      const hasInsert = nodes.some(
        (n) => n.type === "text" && n.marks && JSON.stringify(n.marks) === JSON.stringify(DIFF_INSERT_MARKS),
      )
      expect(hasDelete).toBe(true)
      expect(hasInsert).toBe(true)
    })

    test("identical text produces no marks", () => {
      const nodes = diffNodes("same", "same")
      expect(nodes).toEqual([{ type: "text", text: "same" }])
    })
  })

  describe("blockNodes", () => {
    test("splits on double newlines into paragraphs", () => {
      const blocks = blockNodes("hello\n\nworld")
      expect(blocks).toHaveLength(2)
      expect(blocks[0]).toEqual({ type: "paragraph", content: [{ type: "text", text: "hello" }] })
      expect(blocks[1]).toEqual({ type: "paragraph", content: [{ type: "text", text: "world" }] })
    })

    test("leading/trailing double-newlines create empty paragraphs", () => {
      const blocks = blockNodes("\n\nhello\n\n")
      expect(blocks).toHaveLength(3)
      expect(blocks[0]).toEqual({ type: "paragraph" })
      expect(blocks[2]).toEqual({ type: "paragraph" })
    })
  })

  describe("nodeSize", () => {
    test("sums text lengths and counts hardBreaks as 1", () => {
      const nodes: InlineNode[] = [
        { type: "text", text: "abc" },
        { type: "hardBreak" },
        { type: "text", text: "de" },
      ]
      expect(nodeSize(nodes)).toBe(6) // 3 + 1 + 2
    })
  })
})

// ── normalizeInstruction ──────────────────────────────────────────────

describe("normalizeInstruction", () => {
  test("returns empty string for undefined", () => {
    expect(normalizeInstruction(undefined)).toBe("")
  })

  test("returns empty string for whitespace-only", () => {
    expect(normalizeInstruction("   ")).toBe("")
  })
})

// ── getTopLevelAt ─────────────────────────────────────────────────────

describe("getTopLevelAt", () => {
  function mockEditor(nodes: Array<{ nodeSize: number }>) {
    let offset = 0
    const entries = nodes.map((n) => {
      const pos = offset
      offset += n.nodeSize
      return { pos, nodeSize: n.nodeSize, node: n }
    })
    return {
      state: {
        doc: {
          forEach: (cb: (node: { nodeSize: number }, pos: number) => void) => {
            for (const e of entries) cb(e.node, e.pos)
          },
        },
      },
    }
  }

  test("returns null for empty doc", () => {
    expect(getTopLevelAt(mockEditor([]), 0)).toBeNull()
  })

  test("finds node containing position", () => {
    const result = getTopLevelAt(mockEditor([{ nodeSize: 10 }, { nodeSize: 20 }, { nodeSize: 5 }]), 15)
    expect(result).not.toBeNull()
    expect(result!.index).toBe(1) // pos 10-29
    expect(result!.list).toHaveLength(3)
  })

  test("returns null for position past all nodes", () => {
    expect(getTopLevelAt(mockEditor([{ nodeSize: 10 }]), 10)).toBeNull()
  })

  test("position at node boundary returns next node", () => {
    const result = getTopLevelAt(mockEditor([{ nodeSize: 10 }, { nodeSize: 5 }]), 10)
    expect(result!.index).toBe(1)
  })
})

// ── CONVERT_MENU_ITEMS early-return guard ────────────────────────────

describe("CONVERT_MENU_ITEMS", () => {
  function mockToolbarEditor(activeSet: Set<string> = new Set()) {
    const calls: string[] = []
    const chain: any = new Proxy(
      {},
      {
        get(_, method: string) {
          return (..._args: any[]) => {
            calls.push(method)
            return chain
          }
        },
      },
    )
    return {
      editor: {
        isActive: (...args: any[]) => {
          const name = typeof args[0] === "string" ? args[0] : JSON.stringify(args[0])
          return activeSet.has(name)
        },
        chain: () => {
          calls.push("chain")
          return chain
        },
      },
      calls,
    }
  }

  test("convert-bullet skips toggle when already active (no double-toggle)", () => {
    const item = CONVERT_MENU_ITEMS.find((i) => i.key === "convert-bullet")!
    const { editor, calls } = mockToolbarEditor(new Set(["bulletList"]))
    item.run(editor)
    expect(calls).not.toContain("chain")
  })

  test("convert-bullet runs toggle chain when not active", () => {
    const item = CONVERT_MENU_ITEMS.find((i) => i.key === "convert-bullet")!
    const { editor, calls } = mockToolbarEditor()
    item.run(editor)
    expect(calls).toContain("toggleBulletList")
    expect(calls).toContain("run")
  })
})

// ── AI selection helpers ────────────────────────────────────────────

describe("AI selection helpers", () => {
  describe("clampSelection", () => {
    test("returns null for null input", () => {
      expect(clampSelection(null, 20)).toBeNull()
    })

    test("returns null for invalid max", () => {
      expect(clampSelection({ from: 3, to: 8 }, 0)).toBeNull()
    })

    test("clamps out-of-range selection to document bounds", () => {
      expect(clampSelection({ from: -10, to: 99 }, 20)).toEqual({ from: 1, to: 20 })
    })

    test("keeps to >= from when reversed", () => {
      expect(clampSelection({ from: 8, to: 3 }, 20)).toEqual({ from: 8, to: 8 })
    })
  })

  describe("pickAiSelection", () => {
    test("prefers live selection when both are present", () => {
      const live = { from: 5, to: 9 }
      const cached = { from: 11, to: 14 }
      expect(pickAiSelection(live, cached, 20)).toEqual(live)
    })

    test("falls back to cached selection when live is missing", () => {
      const cached = { from: 11, to: 14 }
      expect(pickAiSelection(null, cached, 20)).toEqual(cached)
    })

    test("falls back to cached selection when live is invalid for doc", () => {
      const live = { from: 3, to: 6 }
      const cached = { from: 9, to: 12 }
      expect(pickAiSelection(live, cached, 0)).toBeNull()
      expect(pickAiSelection(live, cached, 12)).toEqual({ from: 3, to: 6 })
      expect(pickAiSelection({ from: -30, to: -1 }, cached, 20)).toEqual({ from: 1, to: 1 })
    })
  })

  describe("canRunAiMenuItem", () => {
    const improve = AI_MENU_ITEMS.find((item) => item.key === "improve")!
    const summarize = AI_MENU_ITEMS.find((item) => item.key === "summarize")!

    test("requires either live or cached selection for selectionRequired item", () => {
      expect(canRunAiMenuItem(improve, false, false)).toBe(false)
      expect(canRunAiMenuItem(improve, true, false)).toBe(true)
      expect(canRunAiMenuItem(improve, false, true)).toBe(true)
    })

    test("does not require selection for non-selection item", () => {
      expect(canRunAiMenuItem(summarize, false, false)).toBe(true)
    })
  })

  describe("actionNeedsSelection", () => {
    test("returns true for edit actions, false for generative actions", () => {
      expect(actionNeedsSelection("improve")).toBe(true)
      expect(actionNeedsSelection("fix")).toBe(true)
      expect(actionNeedsSelection("continue")).toBe(false)
      expect(actionNeedsSelection("summarize")).toBe(false)
      expect(actionNeedsSelection("custom")).toBe(false)
    })
  })
})

// ── Popover anchoring ────────────────────────────────────────────────

describe("calcAnchoredPopover", () => {
  test("returns null when anchor is missing", () => {
    expect(
      calcAnchoredPopover({
        anchor: null,
        width: 480,
        estimate: 280,
        viewport_height: 900,
        bounds_left: 20,
        bounds_right: 740,
      }),
    ).toBeNull()
  })

  test("anchors below when there is enough room", () => {
    expect(
      calcAnchoredPopover({
        anchor: { x: 200, y: 100 },
        width: 480,
        estimate: 200,
        viewport_height: 900,
        bounds_left: 20,
        bounds_right: 740,
      }),
    ).toEqual({ x: 200, y: 112, width: 480 })
  })

  test("flips above when below would overflow viewport", () => {
    expect(
      calcAnchoredPopover({
        anchor: { x: 200, y: 760 },
        width: 480,
        estimate: 240,
        viewport_height: 900,
        bounds_left: 20,
        bounds_right: 740,
      }),
    ).toEqual({ x: 200, y: 510, width: 480 })
  })

  test("clamps x to left bound", () => {
    expect(
      calcAnchoredPopover({
        anchor: { x: -100, y: 220 },
        width: 480,
        estimate: 220,
        viewport_height: 900,
        bounds_left: 20,
        bounds_right: 740,
      }),
    ).toEqual({ x: 20, y: 232, width: 480 })
  })

  test("clamps x to right bound minus width", () => {
    expect(
      calcAnchoredPopover({
        anchor: { x: 999, y: 220 },
        width: 480,
        estimate: 220,
        viewport_height: 900,
        bounds_left: 20,
        bounds_right: 740,
      }),
    ).toEqual({ x: 260, y: 232, width: 480 })
  })
})

// ── handleScopedSelectAll ───────────────────────────────────────────

describe("handleScopedSelectAll", () => {
  const cmdA = { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: "a" }

  function mockState(size: number, selFrom: number, selTo: number, nodes: Array<{ nodeSize: number }>) {
    let offset = 0
    const entries = nodes.map((n) => {
      const pos = offset
      offset += n.nodeSize
      return { pos, nodeSize: n.nodeSize }
    })
    return {
      doc: {
        content: { size },
        forEach: (cb: (node: { nodeSize: number }, pos: number) => void) => {
          for (const e of entries) cb({ nodeSize: e.nodeSize }, e.pos)
        },
      },
      selection: { from: selFrom, to: selTo },
    }
  }

  test("returns null without modifier key", () => {
    const event = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "a" }
    expect(handleScopedSelectAll(event, mockState(100, 5, 5, [{ nodeSize: 100 }]))).toBeNull()
  })

  test("returns null when alt or shift is held", () => {
    expect(handleScopedSelectAll({ ...cmdA, altKey: true }, mockState(100, 5, 5, [{ nodeSize: 100 }]))).toBeNull()
    expect(handleScopedSelectAll({ ...cmdA, shiftKey: true }, mockState(100, 5, 5, [{ nodeSize: 100 }]))).toBeNull()
  })

  test("handles uppercase 'A' (capslock)", () => {
    const result = handleScopedSelectAll({ ...cmdA, key: "A" }, mockState(50, 5, 5, [{ nodeSize: 50 }]))
    expect(result).not.toBeNull()
  })

  test("returns null when doc is empty", () => {
    expect(handleScopedSelectAll(cmdA, mockState(0, 0, 0, []))).toBeNull()
  })

  test("first Cmd+A selects current block only", () => {
    // Two blocks: [0..20) and [20..50), cursor at pos 5 → inside first block
    const state = mockState(50, 5, 5, [{ nodeSize: 20 }, { nodeSize: 30 }])
    const result = handleScopedSelectAll(cmdA, state)!
    expect(result.from).toBe(1)
    expect(result.to).toBe(19)
  })

  test("second Cmd+A (block already selected) selects entire doc", () => {
    // Selection already covers block from=1 to=19
    const state = mockState(50, 1, 19, [{ nodeSize: 20 }, { nodeSize: 30 }])
    expect(handleScopedSelectAll(cmdA, state)).toEqual({ from: 1, to: 50 })
  })

  test("falls back to full doc when cursor is outside all nodes", () => {
    const state = mockState(100, 100, 100, [{ nodeSize: 20 }])
    expect(handleScopedSelectAll(cmdA, state)).toEqual({ from: 1, to: 100 })
  })
})
