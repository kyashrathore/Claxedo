import { describe, expect, test } from "bun:test"
import { decodePreset } from "./decode"
import { parsedReasons } from "./test-support/refusals"
import { presetRow } from "./test-support/rows"

describe("decodePreset", () => {
  test("reads a stored preset back whole, its agent mark included", () => {
    const marked = decodePreset(presetRow({ id: "preset-1", agentStartable: true }))
    expect(marked.ok && marked.value.agentStartable).toBe(true)
    const unmarked = decodePreset(presetRow({ id: "preset-1", agentStartable: false }))
    expect(unmarked.ok && unmarked.value.agentStartable).toBe(false)
  })

  test("a preset that does not say whether agents may start it is not read as one that forbids them", () => {
    const { agentStartable: _agentStartable, ...unsaid } = presetRow({ id: "preset-1" })
    expect(parsedReasons(decodePreset(unsaid))).toEqual({ "preset.agentStartable": "required" })
    expect(parsedReasons(decodePreset({ ...unsaid, agentStartable: 1 }))).toEqual({ "preset.agentStartable": "type" })
  })
})
