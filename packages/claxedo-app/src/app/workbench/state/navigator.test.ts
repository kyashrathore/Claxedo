import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { emptyClaxedoState } from "./persistence"
import {
  NAVIGATOR_DEFAULT_WIDTH,
  NAVIGATOR_MAX_WIDTH,
  NAVIGATOR_MIN_WIDTH,
  createNavigatorSlice,
} from "./navigator"
import type { ClaxedoState } from "./types"

function makeSlice() {
  const [state, setState] = createStore<ClaxedoState>(emptyClaxedoState())
  return { state, navigator: createNavigatorSlice({ state, setState }) }
}

describe("navigator slice", () => {
  test("starts from the persisted defaults", () => {
    const { navigator } = makeSlice()

    expect(navigator.width()).toBe(NAVIGATOR_DEFAULT_WIDTH)
    expect(navigator.tab()).toBe("changes")
  })

  test("setWidth clamps to the same bounds the validator enforces", () => {
    const { state, navigator } = makeSlice()

    navigator.setWidth(NAVIGATOR_MIN_WIDTH - 1)
    expect(state.navigator.width).toBe(NAVIGATOR_MIN_WIDTH)

    navigator.setWidth(NAVIGATOR_MAX_WIDTH + 1)
    expect(state.navigator.width).toBe(NAVIGATOR_MAX_WIDTH)

    navigator.setWidth(400)
    expect(navigator.width()).toBe(400)

    navigator.setWidth(Number.NaN)
    expect(navigator.width()).toBe(NAVIGATOR_DEFAULT_WIDTH)
  })

  test("select switches the active tab", () => {
    const { state, navigator } = makeSlice()

    navigator.select("files")
    expect(state.navigator.tab).toBe("files")
    expect(navigator.tab()).toBe("files")

    navigator.select("processes")
    expect(navigator.tab()).toBe("processes")
  })
})
