/// <reference types="bun" />
import { afterEach, expect, jest, test } from "bun:test"
import { createDeferredPersistence, DRAFT_SAVE_IDLE_MS } from "./deferred-persistence"
import type { ComposerPersistence, PersistedEntry } from "./persistence"

afterEach(() => {
  jest.useRealTimers()
})

function typed(text: string): PersistedEntry {
  return { draft: { prompt: [{ type: "text", content: text, start: 0, end: text.length }], context: [] }, history: { normal: [], shell: [] } }
}

function fakeStorage() {
  const saved = new Map<string, PersistedEntry>()
  const writes: string[] = []
  const target: ComposerPersistence = {
    load: (key) => saved.get(key),
    save: (key, entry) => {
      writes.push(key)
      saved.set(key, entry)
    },
  }
  return { target, saved, writes }
}

function fakeWindow() {
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" })
  return Object.assign(new EventTarget(), { document }) as unknown as Window & { document: { visibilityState: string } }
}

test("typing writes once, after the pause, with the last text", () => {
  jest.useFakeTimers()
  const storage = fakeStorage()
  const persistence = createDeferredPersistence(storage.target, fakeWindow())
  const text = "hello world, forty keystrokes of prompt"
  for (let length = 1; length <= text.length; length++) {
    persistence.save("session:a", typed(text.slice(0, length)))
    jest.advanceTimersByTime(80)
  }
  expect(storage.writes).toEqual([])
  expect(persistence.load("session:a")).toEqual(typed(text))

  jest.advanceTimersByTime(DRAFT_SAVE_IDLE_MS)
  expect(storage.writes).toEqual(["session:a"])
  expect(storage.saved.get("session:a")).toEqual(typed(text))
  persistence.dispose()
})

test("blur, hiding and unloading the page write what is pending at once", () => {
  jest.useFakeTimers()
  const storage = fakeStorage()
  const view = fakeWindow()
  const persistence = createDeferredPersistence(storage.target, view)

  persistence.save("session:a", typed("a"))
  view.dispatchEvent(new Event("blur"))
  expect(storage.writes).toEqual(["session:a"])

  persistence.save("session:b", typed("b"))
  view.document.dispatchEvent(new Event("visibilitychange"))
  expect(storage.writes).toEqual(["session:a"])
  view.document.visibilityState = "hidden"
  view.document.dispatchEvent(new Event("visibilitychange"))
  expect(storage.writes).toEqual(["session:a", "session:b"])

  persistence.save("draft:p", typed("c"))
  view.dispatchEvent(new Event("pagehide"))
  expect(storage.writes).toEqual(["session:a", "session:b", "draft:p"])

  jest.advanceTimersByTime(DRAFT_SAVE_IDLE_MS)
  expect(storage.writes).toHaveLength(3)
  persistence.dispose()
})

test("disposing writes what is pending and stops listening", () => {
  const storage = fakeStorage()
  const view = fakeWindow()
  const persistence = createDeferredPersistence(storage.target, view)
  persistence.save("session:a", typed("a"))
  persistence.dispose()
  expect(storage.writes).toEqual(["session:a"])
  persistence.save("session:a", typed("ab"))
  view.dispatchEvent(new Event("pagehide"))
  expect(storage.writes).toEqual(["session:a"])
})
