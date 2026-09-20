import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { SelectedLineRange } from "@pierre/diffs"
import { createLineCommentEditorState, createLineCommentState } from "./line-comment-annotations"

describe("line comment state across rendered item lifetimes", () => {
  test("draft text and edit identity survive releasing and remounting the controller", () => {
    createRoot((dispose) => {
      const editor = createLineCommentEditorState<string>()
      const [opened, setOpened] = createSignal<string | null>(null)
      const [selected, setSelected] = createSignal<SelectedLineRange | null>(null)
      const [commenting, setCommenting] = createSignal<SelectedLineRange | null>(null)
      const props = { editor, opened, setOpened, selected, setSelected, commenting, setCommenting }
      const range: SelectedLineRange = { start: 2, end: 4, side: "additions" }
      createRoot((release) => {
        const first = createLineCommentState(props)
        first.openEditor("comment-1", range, "saved text")
        first.setDraft("unfinished edit")
        release()
      })
      createRoot((release) => {
        const restored = createLineCommentState(props)
        expect(restored.draft()).toBe("unfinished edit")
        expect(restored.isEditing("comment-1")).toBe(true)
        expect(restored.selected()).toEqual(range)
        restored.cancelDraft()
        expect(editor.draft()).toBe("")
        expect(editor.editing()).toBeNull()
        release()
      })
      dispose()
    })
  })

  test("new-comment drafts stay isolated between files and reset through the same owner", () => {
    createRoot((dispose) => {
      const firstEditor = createLineCommentEditorState<string>()
      const otherEditor = createLineCommentEditorState<string>()
      const [opened, setOpened] = createSignal<string | null>(null)
      const [selected, setSelected] = createSignal<SelectedLineRange | null>(null)
      const [commenting, setCommenting] = createSignal<SelectedLineRange | null>(null)
      const first = createLineCommentState({
        editor: firstEditor, opened, setOpened, selected, setSelected, commenting, setCommenting,
      })
      first.openDraft({ start: 8, end: 8, side: "deletions" })
      first.setDraft("unfinished new comment")
      expect(firstEditor.draft()).toBe("unfinished new comment")
      expect(otherEditor.draft()).toBe("")
      first.reset()
      expect(firstEditor.draft()).toBe("")
      expect(selected()).toBeNull()
      expect(commenting()).toBeNull()
      dispose()
    })
  })
})
