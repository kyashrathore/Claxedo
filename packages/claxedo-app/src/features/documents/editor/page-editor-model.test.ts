/**
 * Characterization tests for page-editor-model.ts — pure helpers extracted
 * from page-editor.tsx (Plan 005). These pin CURRENT behavior; they are not
 * a spec for desired behavior.
 */

import { describe, expect, test } from "bun:test"
import type { PageStatus } from "@/features/documents/data/pages-api"
import type { ArenaWaveState } from "@/features/documents/data/arena-api"
import {
  allowedStatusTransitions,
  derivePageQuery,
  parsePageContent,
  clampDockWidth,
  computeTocMarks,
  activeTocOrder,
  hasRealAiSelection,
  buildAiRequest,
  visibleArenaWavesOf,
  resolveActiveArenaWave,
  arenaTabLabel,
  errText,
  type TocMark,
  type TocDocNode,
} from "./page-editor-model"

const status = (id: string, transitions: string[]): PageStatus => ({
  id,
  name: id,
  color: "#000000",
  position: 0,
  transitions,
})

describe("allowedStatusTransitions", () => {
  const draft = status("draft", ["review"])
  const review = status("review", ["draft", "done"])
  const done = status("done", [])
  const all = [draft, review, done]

  test("returns every status when the current status is unknown", () => {
    expect(allowedStatusTransitions(undefined, all)).toEqual(all)
  })

  test("filters to the current status's declared transitions", () => {
    expect(allowedStatusTransitions(draft, all)).toEqual([review])
    expect(allowedStatusTransitions(review, all)).toEqual([draft, done])
  })

  test("returns empty for a terminal status with no transitions", () => {
    expect(allowedStatusTransitions(done, all)).toEqual([])
  })
})

describe("derivePageQuery", () => {
  test("project_id set: project scope keyed by project_id, page directory included when present", () => {
    expect(derivePageQuery({ project_id: "p1", directory: "/repo" }, "/other")).toEqual({
      scope: "project",
      project_id: "p1",
      directory: "/repo",
    })
    expect(derivePageQuery({ project_id: "p1", directory: null }, "/other")).toEqual({
      scope: "project",
      project_id: "p1",
    })
  })

  test("project_id === null means global scope", () => {
    expect(derivePageQuery({ project_id: null, directory: "/repo" }, "/other")).toEqual({ scope: "global" })
  })

  test("project_id undefined falls back to the active directory, then '/'", () => {
    expect(derivePageQuery({ directory: null }, "/active")).toEqual({ scope: "project", directory: "/active" })
    expect(derivePageQuery({ directory: null }, undefined)).toEqual({ scope: "project", directory: "/" })
  })
})

describe("parsePageContent", () => {
  test("parses valid JSON documents", () => {
    expect(parsePageContent('{"type":"doc","content":[]}')).toEqual({ type: "doc", content: [] })
  })

  test("returns the raw string when content is not JSON", () => {
    expect(parsePageContent("# plain markdown")).toBe("# plain markdown")
  })

  test("returns empty string for empty/null/undefined content", () => {
    expect(parsePageContent("")).toBe("")
    expect(parsePageContent(null)).toBe("")
    expect(parsePageContent(undefined)).toBe("")
  })
})

describe("clampDockWidth", () => {
  test("SSR branch (no innerWidth) clamps to [360, 900] and rounds", () => {
    expect(clampDockWidth(100)).toBe(360)
    expect(clampDockWidth(1200)).toBe(900)
    expect(clampDockWidth(620.4)).toBe(620)
  })

  test("browser branch clamps max to innerWidth - 320 with a 420 floor on the max", () => {
    expect(clampDockWidth(1000, 1280)).toBe(960) // max = 1280 - 320
    expect(clampDockWidth(1000, 600)).toBe(420) // max = max(420, 280) = 420
    expect(clampDockWidth(100, 1280)).toBe(360) // min stays 360
  })
})

describe("computeTocMarks", () => {
  const doc = (
    nodes: { type: string; text: string; level?: number }[],
  ): TocDocNode => ({
    descendants(visitor) {
      let pos = 0
      for (const node of nodes) {
        visitor(
          {
            type: { name: node.type },
            textContent: node.text,
            attrs: node.level === undefined ? undefined : { level: node.level },
          },
          pos,
        )
        pos += 10
      }
    },
  })

  test("collects headings in order with sequential order indices and positions", () => {
    const marks = computeTocMarks(
      doc([
        { type: "heading", text: "Intro", level: 1 },
        { type: "paragraph", text: "body" },
        { type: "heading", text: "Details", level: 2 },
      ]),
    )
    expect(marks).toEqual([
      { order: 0, pos: 0, title: "Intro", level: 1 },
      { order: 1, pos: 20, title: "Details", level: 2 },
    ])
  })

  test("skips headings whose text is empty after trimming", () => {
    const marks = computeTocMarks(
      doc([
        { type: "heading", text: "   ", level: 1 },
        { type: "heading", text: " Kept ", level: 3 },
      ]),
    )
    expect(marks).toEqual([{ order: 0, pos: 10, title: "Kept", level: 3 }])
  })

  test("defaults level to 1 when the heading has no numeric level attr", () => {
    const marks = computeTocMarks(doc([{ type: "heading", text: "NoLevel" }]))
    expect(marks[0].level).toBe(1)
  })
})

describe("activeTocOrder", () => {
  const mark = (order: number): TocMark => ({ order, pos: order * 10, title: `h${order}`, level: 1 })
  const list = [mark(0), mark(1), mark(2)]

  test("returns -1 for an empty list", () => {
    expect(activeTocOrder([], [])).toBe(-1)
  })

  test("picks the last heading at or above the anchor line (160)", () => {
    expect(activeTocOrder(list, [10, 150, 400])).toBe(1)
    expect(activeTocOrder(list, [10, 20, 30])).toBe(2)
  })

  test("falls back to the first heading when all are below the anchor", () => {
    expect(activeTocOrder(list, [300, 400, 500])).toBe(0)
  })
})

describe("hasRealAiSelection / buildAiRequest", () => {
  test("hasRealAiSelection is false for null and collapsed selections", () => {
    expect(hasRealAiSelection(null)).toBe(false)
    expect(hasRealAiSelection({ from: 5, to: 5 })).toBe(false)
    expect(hasRealAiSelection({ from: 5, to: 9 })).toBe(true)
  })

  const panel = { x: 10, y: 20, width: 620 }

  test("real selection: keeps selected text and includes full-page context", () => {
    const request = buildAiRequest({
      action: "improve",
      selection: { from: 1, to: 8 },
      selectedText: "chosen",
      getFullText: () => "the whole document",
      panel,
    })
    expect(request).toEqual({
      action: "improve",
      instruction: undefined,
      selection: { from: 1, to: 8 },
      text: "chosen",
      context: "the whole document",
      panel,
    })
  })

  test("custom action without a real selection: empty text AND empty context, full text never read", () => {
    let read = 0
    const request = buildAiRequest({
      action: "custom",
      instruction: "write a haiku",
      selection: { from: 4, to: 4 },
      selectedText: "",
      getFullText: () => {
        read += 1
        return "should not be used"
      },
      panel,
    })
    expect(request.text).toBe("")
    expect(request.context).toBe("")
    expect(request.instruction).toBe("write a haiku")
    expect(read).toBe(0)
  })

  test("non-custom action without selection still gets page context, truncated to 14000 chars", () => {
    const request = buildAiRequest({
      action: "summarize",
      selection: null,
      selectedText: "",
      getFullText: () => "x".repeat(20000),
      panel,
    })
    expect(request.text).toBe("")
    expect(request.context).toHaveLength(14000)
  })
})

describe("arena helpers", () => {
  const wave = (id: string, statusValue = "completed"): ArenaWaveState =>
    ({ id, status: statusValue }) as ArenaWaveState

  test("visibleArenaWavesOf maps tab ids to waves in tab order and drops unknown ids", () => {
    const waves = [wave("a"), wave("b"), wave("c")]
    expect(visibleArenaWavesOf(["c", "missing", "a"], waves)).toEqual([waves[2], waves[0]])
  })

  test("resolveActiveArenaWave keeps the pick while visible, else falls back to first visible, else ''", () => {
    const visible = [wave("a"), wave("b")]
    expect(resolveActiveArenaWave("b", visible)).toBe("b")
    expect(resolveActiveArenaWave("gone", visible)).toBe("a")
    expect(resolveActiveArenaWave("", [])).toBe("")
  })

  test("arenaTabLabel numbers waves newest-first and falls back to 'Arena'", () => {
    const waves = [wave("newest"), wave("older"), wave("oldest")]
    expect(arenaTabLabel(waves, "newest")).toBe("Arena 3")
    expect(arenaTabLabel(waves, "oldest")).toBe("Arena 1")
    expect(arenaTabLabel(waves, "unknown")).toBe("Arena")
  })
})

describe("errText", () => {
  test("unwraps JSON error bodies from Error messages", () => {
    expect(errText(new Error('{"error":"model exploded"}'))).toBe("model exploded")
  })

  test("returns the raw message when not JSON or when the error field is blank", () => {
    expect(errText(new Error("plain failure"))).toBe("plain failure")
    expect(errText(new Error('{"error":"  "}'))).toBe('{"error":"  "}')
  })

  test("stringifies non-Error values", () => {
    expect(errText("oops")).toBe("oops")
  })
})
