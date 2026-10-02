import { expect, test } from "bun:test"
import { permissionModeStateFromWire } from "./permission-modes"

test.each(["immediate", "next-turn", "next-session"])("permission mode wire preserves %s delivery", (appliesFrom) => {
  expect(permissionModeStateFromWire({ modes: [{ id: "default", name: "Default" }], currentModeId: "default", appliesFrom }))
    .toMatchObject({ currentModeId: "default", appliesFrom })
})

test("unknown delivery timing is a contract failure", () => {
  expect(() => permissionModeStateFromWire({ modes: [], appliesFrom: "later" })).toThrow("valid delivery timing")
})
