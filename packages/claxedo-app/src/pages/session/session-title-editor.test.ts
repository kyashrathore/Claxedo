import { describe, expect, test } from "bun:test"
import {
  emptyTitleEditorState,
  openTitleEditorPatch,
  resolveTitleSave,
} from "./session-title-editor"

describe("resolveTitleSave", () => {
  test("commits the trimmed draft when it differs from the current title", () => {
    expect(resolveTitleSave({ draft: "  Renamed  ", currentTitle: "Old" })).toEqual({
      commit: true,
      title: "Renamed",
    })
  })

  test("no-ops on an empty or whitespace-only draft", () => {
    expect(resolveTitleSave({ draft: "", currentTitle: "Old" })).toEqual({ commit: false })
    expect(resolveTitleSave({ draft: "   ", currentTitle: "Old" })).toEqual({ commit: false })
  })

  test("no-ops when the trimmed draft equals the current title", () => {
    expect(resolveTitleSave({ draft: "Same", currentTitle: "Same" })).toEqual({ commit: false })
    expect(resolveTitleSave({ draft: "  Same  ", currentTitle: "Same" })).toEqual({ commit: false })
  })

  test("treats a null/undefined current title as empty", () => {
    expect(resolveTitleSave({ draft: "", currentTitle: undefined })).toEqual({ commit: false })
    expect(resolveTitleSave({ draft: "", currentTitle: null })).toEqual({ commit: false })
    expect(resolveTitleSave({ draft: "First", currentTitle: undefined })).toEqual({
      commit: true,
      title: "First",
    })
  })
})

describe("openTitleEditorPatch", () => {
  test("opens with the current title pre-filled as the draft", () => {
    expect(openTitleEditorPatch({ hasSession: true, currentTitle: "Hello" })).toEqual({
      editing: true,
      draft: "Hello",
    })
  })

  test("opens with an empty draft when there is no current title", () => {
    expect(openTitleEditorPatch({ hasSession: true, currentTitle: undefined })).toEqual({
      editing: true,
      draft: "",
    })
  })

  test("refuses to open without a session", () => {
    expect(openTitleEditorPatch({ hasSession: false, currentTitle: "x" })).toBeUndefined()
  })

  test("refuses to open for a child session (parent present)", () => {
    expect(openTitleEditorPatch({ hasSession: true, isChild: true, currentTitle: "x" })).toBeUndefined()
  })
})

describe("emptyTitleEditorState", () => {
  test("is the fully-reset editor shape", () => {
    expect(emptyTitleEditorState()).toEqual({
      draft: "",
      editing: false,
      saving: false,
      menuOpen: false,
      pendingRename: false,
    })
  })
})
