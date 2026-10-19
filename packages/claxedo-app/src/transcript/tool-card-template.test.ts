import { describe, expect, test } from "bun:test"
import type { ToolCardLink, ToolCardTemplate } from "@claxedo/plugin-api"
import { cardText, pointerValue, toolCardFields, type TranscriptToolCard } from "./tool-card-template"

const pages: Readonly<Record<string, string>> = { notes: "/notes" }

function card(template: ToolCardTemplate): TranscriptToolCard {
  return {
    template,
    pageHref: (pageId, params) => (pages[pageId] ? `${pages[pageId]}/${params.noteId}` : undefined),
  }
}

const noteLink: ToolCardLink = {
  kind: "page",
  pageId: "notes",
  params: { noteId: { first: [{ path: "/result/note/id" }, { path: "/args/note" }] } },
  label: { first: [{ format: "#{/result/note/key} {/result/note/title}" }, { path: "/args/note", max: 6 }] },
}

const noteCard: ToolCardTemplate = {
  tool: "note_save",
  title: "Save note",
  link: noteLink,
  subject: { path: "/args/folder" },
  status: { value: { first: [{ path: "/result/note/state" }, "draft"] }, states: { saved: { label: "Saved", icon: "checkCircle", tone: "success" } } },
  notes: [
    { when: { path: "/result/replayed", equals: true }, text: "already saved" },
    { when: { path: "/result" }, text: "saved now" },
  ],
  facts: [
    { label: "Session", value: { kind: "session", sessionId: { path: "/result/sessionId" } } },
    { label: "Words", value: { count: { path: "/result/note/words", one: "word", other: "words" } }, when: { path: "/result/note" } },
    { label: "Path", value: { path: "/result/path" }, mono: true },
  ],
}

describe("pointerValue", () => {
  test("follows object keys and array indexes, unescaping ~1 and ~0", () => {
    const document = { a: [{ "b/c": { "d~e": 7 } }] }
    expect(pointerValue(document, "/a/0/b~1c/d~0e")).toBe(7)
    expect(pointerValue(document, "/a/01")).toBeUndefined()
    expect(pointerValue(document, "/a/x")).toBeUndefined()
    expect(pointerValue(document, "")).toBe(document)
  })
})

describe("cardText", () => {
  test("a format resolves only when every placeholder does, so first falls through to the next choice", () => {
    const text = { first: [{ format: "#{/key} {/title}" }, { format: "#{/key}" }, { path: "/id", max: 5 }] } as const
    expect(cardText(text, { key: 4, title: "Ship" })).toBe("#4 Ship")
    expect(cardText(text, { key: 4 })).toBe("#4")
    expect(cardText(text, { id: "tsk_123456" })).toBe("tsk_…")
    expect(cardText(text, {})).toBeUndefined()
  })

  test("a count reads an array's length or a number, and an empty string is no text", () => {
    const count = { count: { path: "/n", one: "task", other: "tasks" } }
    expect(cardText(count, { n: [1] })).toBe("1 task")
    expect(cardText(count, { n: 3 })).toBe("3 tasks")
    expect(cardText(count, {})).toBeUndefined()
    expect(cardText({ path: "/s" }, { s: "  " })).toBeUndefined()
  })
})

describe("toolCardFields", () => {
  test("a finished call draws its link to the plugin's page, status, first holding note and every fact that resolves", () => {
    const fields = toolCardFields(card(noteCard), {
      args: { folder: "Inbox" },
      result: { note: { id: "n1", key: 7, title: "Plan", state: "saved", words: 2 }, sessionId: "ses_1", path: "/notes/plan.md" },
    })
    expect(fields).toEqual({
      link: { kind: "page", href: "/notes/n1", label: "#7 Plan" },
      subject: "Inbox",
      status: { label: "Saved", icon: "checkCircle", tone: "success" },
      note: "saved now",
      facts: [
        { label: "Session", value: "ses_1", link: { kind: "session", id: "ses_1", label: "ses_1" } },
        { label: "Words", value: "2 words" },
        { label: "Path", value: "/notes/plan.md", mono: true },
      ],
      rows: [],
    })
  })

  test("a running call draws from its arguments, and an unknown status value is its own words", () => {
    const fields = toolCardFields(card(noteCard), { args: { note: "n2-long-id" }, result: undefined })
    expect(fields.link).toEqual({ kind: "page", href: "/notes/n2-long-id", label: "n2-lo…" })
    expect(fields.status).toEqual({ label: "draft", tone: "neutral" })
    expect(fields.note).toBeUndefined()
    expect(fields.facts).toEqual([])
  })

  test("a link whose page is not registered keeps its label as text", () => {
    const fields = toolCardFields(card({ ...noteCard, link: { ...noteLink, pageId: "missing" } }), { args: { note: "n3" }, result: undefined })
    expect(fields.link).toEqual({ kind: "page", href: undefined, label: "n3" })
  })

  test("rows are cut at their cap with how many more, or say more is available when the result names a next page", () => {
    const listed: ToolCardTemplate = {
      tool: "note_list",
      title: "List notes",
      rows: {
        path: "/result/notes",
        link: { kind: "page", pageId: "notes", params: { noteId: { path: "/id" } }, label: { path: "/title" } },
        status: { value: { path: "/state" }, states: {} },
        max: 2,
        more: "+{count} more",
        continued: { when: { path: "/result/next" }, text: "more available" },
      },
    }
    const notes = [{ id: "a", title: "A", state: "kept_aside" }, { id: "b", title: "B" }, { id: "c", title: "C" }, { title: "" }]
    const cut = toolCardFields(card(listed), { args: {}, result: { notes } })
    expect(cut.rows).toEqual([
      { link: { kind: "page", href: "/notes/a", label: "A" }, status: { label: "kept aside", tone: "neutral" } },
      { link: { kind: "page", href: "/notes/b", label: "B" } },
    ])
    expect(cut.more).toBe("+1 more")
    expect(toolCardFields(card(listed), { args: {}, result: { notes: notes.slice(0, 2), next: "c2" } }).more).toBe("more available")
    expect(toolCardFields(card(listed), { args: {}, result: { notes: notes.slice(0, 2) } }).more).toBeUndefined()
  })
})
