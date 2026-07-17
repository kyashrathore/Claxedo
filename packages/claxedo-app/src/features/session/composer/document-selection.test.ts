import { describe, expect, test } from "bun:test"
import {
  documentSelectionIsCurrent,
  runForCurrentDocumentSelection,
  type DocumentSelectionState,
} from "./document-selection"

const started: DocumentSelectionState = {
  generation: 1, scope: "scope-a", sessionId: "session-a", draftId: "draft-a", prompt: "/docs",
}

describe("document selection guard", () => {
  test("accepts the unchanged initiating draft", () => {
    expect(documentSelectionIsCurrent(started, { ...started })).toBe(true)
  })

  test("rejects newer typing, a new selection, and session switches", () => {
    expect(documentSelectionIsCurrent(started, { ...started, prompt: "/docs plus newer text" })).toBe(false)
    expect(documentSelectionIsCurrent(started, { ...started, generation: 2 })).toBe(false)
    expect(documentSelectionIsCurrent(started, { ...started, sessionId: "session-b" })).toBe(false)
  })

  test("ignores transient draft bookkeeping after the selection belongs to a real session", () => {
    expect(documentSelectionIsCurrent(started, { ...started, draftId: "draft-b" })).toBe(true)
    expect(documentSelectionIsCurrent(
      { ...started, sessionId: undefined },
      { ...started, sessionId: undefined, draftId: "draft-b" },
    )).toBe(false)
  })

  test("an older overlapping request cannot close a newly opened picker when it resolves last", async () => {
    let generation = 1
    let pickerOpen = true
    let resolveOlder = () => {}
    const older = new Promise<void>((resolve) => {
      resolveOlder = resolve
    })
    const olderStarted = { ...started, generation }
    const current = () => ({ ...started, generation })
    const olderFinished = older.finally(() => {
      runForCurrentDocumentSelection(olderStarted, current, () => {
        pickerOpen = false
      })
    })

    generation += 1
    const newerStarted = { ...started, generation }
    runForCurrentDocumentSelection(newerStarted, current, () => {
      pickerOpen = false
    })
    pickerOpen = true
    resolveOlder()
    await olderFinished

    expect(pickerOpen).toBe(true)
  })
})
