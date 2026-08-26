import { expect, test } from "vitest"
import { createMemo, createRoot, createSignal, flush } from "solid-js"
import type { Part } from "@opencode-ai/sdk/v2"
import { sameArrayItems, samePartsRecord } from "./timeline-row-equality"

test("array equality accepts a Solid memo's first value after loading", () => {
  const state = createRoot((dispose) => {
    const [source, setSource] = createSignal<readonly string[] | undefined>()
    const value = createMemo(() => source(), { equals: sameArrayItems, loadingValue: undefined })
    return { dispose, setSource, value }
  })

  expect(state.value()).toBeUndefined()
  state.setSource(["assistant-message"])
  flush()

  expect(state.value()).toEqual(["assistant-message"])
  state.dispose()
})

test("parts equality accepts a Solid memo's first value after loading", () => {
  const state = createRoot((dispose) => {
    const [source, setSource] = createSignal<Record<string, Part[]> | undefined>()
    const value = createMemo(() => source(), { equals: samePartsRecord, loadingValue: undefined })
    return { dispose, setSource, value }
  })

  expect(state.value()).toBeUndefined()
  state.setSource({ msg_1: [] })
  flush()

  expect(state.value()).toEqual({ msg_1: [] })
  state.dispose()
})
