/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { ImagePart, Prompt } from "./model"
import { promptFilled, promptImages, promptText, quoteContextItem } from "./model"
import { buildPromptInput, createComposerSend } from "./send"
import { createComposerStore } from "./store"
import type { SessionView } from "@/session"

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

test("a refused queue replacement preserves the edit and never sends a fresh prompt", async () => {
  const store = createComposerStore()
  store.setPrompt(KEY, [{ type: "text", content: "edited queued input", start: 0, end: 19 }], 19)
  let sends = 0
  let accepted = 0
  const view = { send: async () => { sends++ } } as unknown as SessionView
  const send = createRoot(() => createComposerSend({
    key: () => KEY, store, mode: () => "normal", normalMode: () => undefined,
    submission: async () => ({}), working: () => true, goalCapable: () => false,
    view: () => view, queuedReplace: () => async () => false,
    afterAccepted: () => { accepted++ }, focusEditor: () => undefined, goalStopFailed: () => undefined,
  }))
  await send.send()
  expect(sends).toBe(0)
  expect(accepted).toBe(0)
  expect(promptText(store.draft(KEY).prompt)).toBe("edited queued input")
  expect(send.state().kind).toBe("rejected")
})

test("saving a queue edit captures it before asynchronous settings and leaves the unsent draft alone once the edit ends", async () => {
  const store = createComposerStore()
  store.setPrompt(KEY, [{ type: "text", content: "Original draft", start: 0, end: 14 }, IMAGE], 14)
  store.setGoalArmed(KEY, true)
  store.forkDraft(KEY, { prompt: [{ type: "text", content: "/goal edited input", start: 0, end: 18 }], context: [], goalArmed: false })
  let replacing = true
  let sends = 0
  const prompts: Awaited<ReturnType<typeof buildPromptInput>>[] = []
  let release = () => {}
  const settings = new Promise<void>((resolve) => { release = resolve })
  const view = { send: async () => { sends++ } } as unknown as SessionView
  const replace = async (prompt: Awaited<ReturnType<typeof buildPromptInput>>) => {
    prompts.push(prompt)
    store.dropFork(KEY)
    return true
  }
  const send = createRoot(() => createComposerSend({
    key: () => KEY, store, mode: () => "normal", normalMode: () => undefined,
    submission: async () => { await settings; return {} }, working: () => true, goalCapable: () => true,
    view: () => view, queuedReplace: () => replacing ? replace : undefined,
    focusEditor: () => undefined, goalStopFailed: () => undefined,
  }))
  const saved = send.send()
  replacing = false
  release()
  await saved
  expect(sends).toBe(0)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]?.text).toBe("/goal edited input")
  expect(prompts[0]?.goal).toBeUndefined()
  expect(promptText(store.draft(KEY).prompt)).toBe("Original draft")
  expect(promptImages(store.draft(KEY).prompt)).toEqual([IMAGE])
  expect(store.draft(KEY).goalArmed).toBe(true)
})

test("a first send its host withdraws puts the text back and returns to editing with no toast-raising rejection", async () => {
  const store = createComposerStore()
  const key = "draft:edit" as const
  store.setPrompt(key, [{ type: "text", content: "Fix the login bug", start: 0, end: 17 }], 17)
  let accepted = 0
  const send = createRoot(() => createComposerSend({
    key: () => key, store, mode: () => "normal", normalMode: () => undefined,
    submission: async () => ({}), working: () => false, goalCapable: () => false,
    view: () => undefined, queuedReplace: () => undefined, startSession: async () => undefined,
    afterAccepted: () => { accepted++ }, focusEditor: () => undefined, goalStopFailed: () => undefined,
  }))
  await send.send()
  expect(send.state().kind).toBe("editing")
  expect(accepted).toBe(0)
  expect(promptText(store.draft(key).prompt)).toBe("Fix the login bug")
})
