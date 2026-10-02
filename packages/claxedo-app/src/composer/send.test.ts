/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { ImagePart, Prompt } from "./model"
import { promptFilled, promptImages, promptText, quoteContextItem } from "./model"
import { buildPromptInput, createComposerSend } from "./send"
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

test("a quoted excerpt with its comment travels as one text note naming where it came from", async () => {
  const quote = quoteContextItem({ source: { kind: "file", path: "docs/guide.md" }, quote: "Install it first.", comment: "Which version?" })
  const input = await buildPromptInput({
    draft: { prompt: [{ type: "text", content: "", start: 0, end: 0 }], context: [quote], goalArmed: false },
    submission: {},
    goal: { kind: "none" },
    delivery: undefined,
  })
  expect(input.attachments).toEqual([
    {
      kind: "text",
      label: "docs/guide.md",
      text: "The user made the following comment regarding this excerpt from the file docs/guide.md:\n> Install it first.\n\nWhich version?",
    },
  ])
})

test("a draft holding only a quoted comment can be sent", () => {
  const quote = quoteContextItem({ source: { kind: "conversation" }, quote: "q", comment: "c" })
  expect(promptFilled({ prompt: [{ type: "text", content: "", start: 0, end: 0 }], context: [quote] })).toBe(true)
})
