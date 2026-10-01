/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createControllerContext } from "./controller-context"
import type { ImagePart } from "./model"
import { promptImages, promptText } from "./model"
import { selectSlash } from "./popover-actions"
import { createComposerRefs } from "./refs"
import { createComposerStore } from "./store"
import type { SlashItem } from "./suggestions"

const KEY = "session:slash"
const IMAGE: ImagePart = { type: "image", id: "img-1", filename: "shot.png", mime: "image/png", dataUrl: "data:image/png;base64,AA==" }
const GOAL: SlashItem = { type: "builtin", id: "prompt.goal", trigger: "goal", title: "Goal" }

test("picking a built-in slash command drops the typed trigger and keeps images", () => {
  const store = createComposerStore()
  store.setPrompt(KEY, [{ type: "text", content: "/go", start: 0, end: 3 }, IMAGE], 3)
  const ran: SlashItem[] = []
  const context = createRoot(() =>
    createControllerContext({
      key: () => KEY,
      store,
      refs: createComposerRefs(),
      working: () => false,
      atItems: () => [],
      slashItems: () => [GOAL],
      submit: () => undefined,
      stop: () => undefined,
      edited: () => undefined,
      runCommand: (item) => ran.push(item),
    }),
  )
  selectSlash(context, GOAL)
  expect(ran).toEqual([GOAL])
  expect(promptText(store.draft(KEY).prompt)).toBe("")
  expect(promptImages(store.draft(KEY).prompt)).toEqual([IMAGE])
})
