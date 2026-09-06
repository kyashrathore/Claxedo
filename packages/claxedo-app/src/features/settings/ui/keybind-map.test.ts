import { describe, expect, test } from "bun:test"
import { parseKeybindMap } from "./keybind-map"

describe("parseKeybindMap", () => {
  test("keeps every string-valued command binding", () => {
    expect(parseKeybindMap({ "command.palette": "mod+shift+p", "session.new": "mod+n" })).toEqual({
      "command.palette": "mod+shift+p",
      "session.new": "mod+n",
    })
  })

  test("drops entries whose value is not a string", () => {
    // A hand-edited config can store anything here. Every consumer hands the
    // value to `parseKeybind`, which splits it — so a number reaching a caller
    // is a crash, not a mis-render.
    expect(parseKeybindMap({
      "session.new": "mod+n",
      "session.close": 42,
      "session.share": null,
      "session.fork": { key: "f" },
      "session.copy": ["mod", "c"],
      "session.undo": undefined,
    })).toEqual({ "session.new": "mod+n" })
  })

  test("an empty binding string is kept, because clearing a binding is meaningful", () => {
    expect(parseKeybindMap({ "session.new": "" })).toEqual({ "session.new": "" })
  })

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "mod+n"],
    ["a number", 3],
    ["an array", [["session.new", "mod+n"]]],
  ])("%s is not a keybind map and yields an empty one", (_label, value) => {
    expect(parseKeybindMap(value)).toEqual({})
  })
})
