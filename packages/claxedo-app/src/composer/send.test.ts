/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { ImagePart, Prompt } from "./model"
import { promptImages, promptText } from "./model"
import { createComposerSend } from "./send"
import { createComposerStore } from "./store"

const KEY = "session:goal"
const IMAGE: ImagePart = { type: "image", id: "img-1", filename: "shot.png", mime: "image/png", dataUrl: "data:image/png;base64,AA==" }

function composerWith(prompt: Prompt) {
  globalThis.requestAnimationFrame = () => 0
  const store = createComposerStore()
  store.setPrompt(KEY, prompt, promptText(prompt).length)
  const send = createRoot(() =>
    createComposerSend({
      key: () => KEY,
      store,
      mode: () => "normal",
      normalMode: () => undefined,
      submission: async () => ({}),
      working: () => false,
      goalCapable: () => true,
      view: () => undefined,
      queuedReplace: () => undefined,
      focusEditor: () => undefined,
      goalStopFailed: () => undefined,
    }),
  )
  return { store, send }
}

test("arming a Goal from the menu keeps the typed text and images", () => {
  const { store, send } = composerWith([{ type: "text", content: "ship the release notes", start: 0, end: 22 }, IMAGE])
  send.armGoal()
  expect(store.draft(KEY).goalArmed).toBe(true)
  expect(promptText(store.draft(KEY).prompt)).toBe("ship the release notes")
  expect(promptImages(store.draft(KEY).prompt)).toEqual([IMAGE])
})

test("sending a bare /goal arms a Goal and drops only the command text", async () => {
  const { store, send } = composerWith([{ type: "text", content: "/goal", start: 0, end: 5 }, IMAGE])
  await send.send()
  expect(store.draft(KEY).goalArmed).toBe(true)
  expect(promptText(store.draft(KEY).prompt)).toBe("")
  expect(promptImages(store.draft(KEY).prompt)).toEqual([IMAGE])
})
