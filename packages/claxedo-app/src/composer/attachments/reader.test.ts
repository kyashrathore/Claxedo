import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { promptImages, promptText, type Draft } from "../model"
import { createComposerStore } from "../store"
import { createAttachmentReader } from "./reader"

const KEY = "session:s1"
const text = (content: string) => [{ type: "text" as const, content, start: 0, end: content.length }]
const draftOf = (content: string): Draft => ({ prompt: text(content), context: [], goalArmed: false })

const reads: Array<() => void> = []

class HeldFileReader extends EventTarget {
  result: string | null = null
  error: Error | null = null
  readAsDataURL(file: File) {
    reads.push(() => {
      void file.arrayBuffer().then((bytes) => {
        this.result = `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`
        this.dispatchEvent(new Event("load"))
      })
    })
  }
}

const original = globalThis.FileReader
beforeAll(() => void (globalThis.FileReader = HeldFileReader as unknown as typeof FileReader))
afterEach(() => void reads.splice(0))
afterAll(() => void (globalThis.FileReader = original))

function arrange() {
  const store = createComposerStore()
  const reader = createRoot(() =>
    createAttachmentReader({
      key: () => KEY, store, editor: () => undefined, zone: () => undefined, isDialogActive: () => false,
      target: () => ({ workspace: true }), setDraggingType: () => undefined, focusEditor: () => undefined,
    }),
  )
  const read = async (meanwhile: () => void) => {
    const added = reader.add(new File(["png"], "shot.png", { type: "image/png" }))
    while (reads.length === 0) await Bun.sleep(0)
    meanwhile()
    reads.shift()!()
    return added
  }
  return { store, read }
}

test("an image still reading when its queue edit is cancelled is discarded, not added to the session draft", async () => {
  const { store, read } = arrange()
  store.setPrompt(KEY, text("Keep my unsent draft"), 20)
  store.forkDraft(KEY, draftOf("Edited queue item"))
  expect(await read(() => store.dropFork(KEY))).toBe(false)
  expect(promptText(store.draft(KEY).prompt)).toBe("Keep my unsent draft")
  expect(promptImages(store.draft(KEY).prompt)).toEqual([])
  expect(store.attachments(KEY)).toEqual([])
})

test("an image still reading when its queue edit joins the session draft lands there", async () => {
  const { store, read } = arrange()
  store.forkDraft(KEY, draftOf("Edited queue item"))
  expect(await read(() => store.joinFork(KEY))).toBe(true)
  expect(promptText(store.draft(KEY).prompt)).toBe("Edited queue item")
  expect(promptImages(store.draft(KEY).prompt).map((image) => image.filename)).toEqual(["shot.png"])
})

test("an image dropped into the session draft stays there when a queue edit opens before it is read", async () => {
  const { store, read } = arrange()
  store.setPrompt(KEY, text("Keep my unsent draft"), 20)
  expect(await read(() => store.forkDraft(KEY, draftOf("Edited queue item")))).toBe(true)
  expect(promptImages(store.draft(KEY).prompt)).toEqual([])
  store.dropFork(KEY)
  expect(promptImages(store.draft(KEY).prompt).map((image) => image.filename)).toEqual(["shot.png"])
})
