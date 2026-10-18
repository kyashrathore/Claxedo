/// <reference types="bun" />
import { expect, test } from "bun:test"
import { isSubmitKey, type SubmitKeyEvent } from "./submit-key"

const key = (name: string, modifiers: Partial<SubmitKeyEvent> = {}): SubmitKeyEvent => ({
  key: name,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  ...modifiers,
})

test("a one-line field submits on a plain Enter only", () => {
  const events = [key("Enter"), key("Enter", { shiftKey: true }), key("Enter", { metaKey: true }), key("a")]
  expect(events.map((event) => isSubmitKey(event, false))).toEqual([true, false, false, false])
})

test("a long-text field submits on Mod+Enter or Mod+S, and Enter alone adds a line", () => {
  const events = [key("Enter"), key("Enter", { metaKey: true }), key("Enter", { ctrlKey: true }), key("s", { metaKey: true }), key("S", { ctrlKey: true }), key("s")]
  expect(events.map((event) => isSubmitKey(event, true))).toEqual([false, true, true, true, true, false])
})

test("no key submits while an input method is composing", () => {
  expect([isSubmitKey(key("Enter", { isComposing: true }), false), isSubmitKey(key("Enter", { metaKey: true, isComposing: true }), true)]).toEqual([false, false])
})
