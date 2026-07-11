import { describe, expect, test } from "bun:test"
import { harness } from "./state-harness"
import { validate } from "../index"

describe("L. persistence round-trip", () => {
  test("state JSON-stringified and re-parsed through validate is identical", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    const serialized = JSON.stringify(h.state())
    const { state, dirty } = validate(JSON.parse(serialized))
    expect(state).toEqual(h.state())
    expect(dirty).toBe(false)
  })

  test("snapshots survive serialize/parse/validate", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.contents.add("c")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    h.api.navigation.show("c")
    const { state } = validate(JSON.parse(JSON.stringify(h.state())))
    expect(state.layoutSnapshots["a"]).toBeDefined()
    expect(state.layoutSnapshots["b"]).toBeDefined()
  })

  test("contentRecency survives round-trip", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.contents.add("c")
    h.api.navigation.show("a")
    const { state } = validate(JSON.parse(JSON.stringify(h.state())))
    expect(state.contentRecency).toEqual(h.state().contentRecency)
  })
})
