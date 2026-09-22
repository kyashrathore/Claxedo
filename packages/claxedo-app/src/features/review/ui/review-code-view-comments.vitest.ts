import { createRoot, createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createReviewCodeViewComments, type SessionReviewComment } from "./review-code-view-comments"

// The real comment controllers, not a stand-in: what is under test is which of
// them exist at a given moment, and what survives their disposal.

const diffs = [{ file: "a.ts", before: "one\ntwo\nthree\n", after: "one\nTWO\nthree\n" }]

const disposers: VoidFunction[] = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
})

function harness(comments: () => SessionReviewComment[]) {
  const onLineComment = vi.fn()
  const onLineCommentUpdate = vi.fn()
  const onLineCommentDelete = vi.fn()
  const registry = createRoot((dispose) => {
    disposers.push(dispose)
    return createReviewCodeViewComments({
      comments,
      diffs: () => diffs,
      actions: () => ({ moreLabel: "More", editLabel: "Edit", deleteLabel: "Delete", saveLabel: "Save" }),
      onLineComment,
      onLineCommentUpdate,
      onLineCommentDelete,
    })
  })
  return { registry, onLineComment, onLineCommentUpdate, onLineCommentDelete }
}

const comment = (overrides: Partial<SessionReviewComment> = {}): SessionReviewComment => ({
  id: "c1",
  file: "a.ts",
  selection: { start: 2, end: 6, side: "additions" },
  comment: "look here",
  ...overrides,
})

describe("review comment owners follow the engine's rendered items", () => {
  const textareaIn = (host: HTMLElement) => {
    const textarea = host.querySelector("[data-slot=line-comment-textarea]")
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("the draft editor has no textarea")
    return textarea
  }

  it("releases a drafting file's controller off screen and rebuilds it with the typed text", () => {
    const { registry } = harness(() => [])
    const owner = registry.owner("a.ts")
    registry.onRenderedFilesChange(["a.ts"])

    owner.onLineSelectionEnd({ start: 2, end: 2, side: "additions" })
    const drafting = registry.annotations("a.ts")
    expect(drafting.map((annotation) => annotation.metadata.kind)).toEqual(["draft"])
    const host = owner.renderAnnotation(drafting[0])
    if (!(host instanceof HTMLElement)) throw new Error("the draft annotation rendered no host")

    const textarea = textareaIn(host)
    textarea.value = "half a thought"
    textarea.dispatchEvent(new Event("input", { bubbles: true }))

    // Scrolling away releases the controller and every node it rendered, with
    // no exemption for the file the user was drafting in.
    registry.onRenderedFilesChange([])
    expect(host.childNodes.length).toBe(0)
    expect(textarea.isConnected).toBe(false)

    // The draft is state, not DOM: it is still in the document's annotations,
    // and a rebuilt owner renders it again with what was typed.
    const restored = registry.annotations("a.ts")
    expect(restored.map((annotation) => annotation.metadata.kind)).toEqual(["draft"])
    const rebuilt = registry.owner("a.ts")
    expect(rebuilt === owner).toBe(false)
    const rebuiltHost = rebuilt.renderAnnotation(restored[0])
    if (!(rebuiltHost instanceof HTMLElement)) throw new Error("the rebuilt draft rendered no host")
    expect(rebuiltHost === host).toBe(false)
    expect(textareaIn(rebuiltHost).value).toBe("half a thought")
  })

  it("a draft that keeps its end line but moves its start is a different annotation", () => {
    const { registry } = harness(() => [])
    const owner = registry.owner("a.ts")
    owner.onLineSelectionEnd({ start: 6, end: 6, side: "additions" })
    const first = registry.annotations("a.ts")
    owner.onLineSelectionEnd({ start: 4, end: 6, side: "additions" })
    const next = registry.annotations("a.ts")
    expect(next === first).toBe(false)
    const metadata = next[0]!.metadata
    if (metadata.kind !== "draft") throw new Error("expected a draft annotation")
    expect(metadata.range.start).toBe(4)
  })

  it("a collapsed row releases its owner even while its header is still rendered", () => {
    const { registry } = harness(() => [comment()])
    const owner = registry.owner("a.ts")
    registry.onRenderedFilesChange(["a.ts"])
    // The surface reports expanded rendered files only, so a collapse arrives
    // here as the file leaving the set.
    registry.onRenderedFilesChange([])
    expect(registry.owner("a.ts") === owner).toBe(false)
  })

  it("keeps an owner while its file stays in the rendered set", () => {
    const { registry } = harness(() => [comment()])
    const owner = registry.owner("a.ts")
    registry.onRenderedFilesChange(["a.ts", "b.ts"])
    registry.onRenderedFilesChange(["a.ts"])
    expect(registry.owner("a.ts") === owner).toBe(true)
  })
})

describe("review comment annotation identity", () => {
  it("treats a selection that keeps its end line but moves its start as a change", () => {
    const [comments, setComments] = createSignal([comment({ selection: { start: 2, end: 6, side: "additions" } })])
    const { registry } = harness(comments)
    const first = registry.annotations("a.ts")
    expect(first).toHaveLength(1)

    setComments([comment({ selection: { start: 4, end: 6, side: "additions" } })])
    const next = registry.annotations("a.ts")
    expect(next === first).toBe(false)
    const metadata = next[0]!.metadata
    if (metadata.kind !== "comment") throw new Error("expected a comment annotation")
    expect(metadata.comment.selection.start).toBe(4)
  })

  it("treats a selection that keeps its range but changes side as a change", () => {
    const [comments, setComments] = createSignal([comment({ selection: { start: 2, end: 6, side: "additions" } })])
    const { registry } = harness(comments)
    const first = registry.annotations("a.ts")
    setComments([comment({ selection: { start: 2, end: 6, side: "additions", endSide: "deletions" } })])
    expect(registry.annotations("a.ts") === first).toBe(false)
  })

  it("keeps the same array when nothing about the file's comments changed", () => {
    const [comments, setComments] = createSignal([comment()])
    const { registry } = harness(comments)
    const first = registry.annotations("a.ts")
    setComments([comment()])
    expect(registry.annotations("a.ts") === first).toBe(true)
  })

  it("reports one shared empty list for files with no comments and no draft", () => {
    const { registry } = harness(() => [comment()])
    expect(registry.annotations("b.ts") === registry.annotations("c.ts")).toBe(true)
    expect(registry.annotations("b.ts")).toHaveLength(0)
  })
})
