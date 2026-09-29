import { expect, test } from "bun:test"
import { CURSOR_PERMISSION_MODES } from "@claxedo/agent-runtime-contract"
import { cursorPermissionModeState, permissionLocalOptions, protocolPermissionMap } from "./permission-modes"

test("every mode in the contract's Cursor table maps to its own local agent options, and nothing else does", () => {
  expect(Object.keys(protocolPermissionMap).sort()).toEqual(CURSOR_PERMISSION_MODES.modes.map((mode) => mode.id).sort())
})

test("with nothing chosen Cursor gets no sandbox options and the session names no mode", () => {
  expect(permissionLocalOptions({})).toEqual({})
  expect(cursorPermissionModeState({})).toEqual({ modes: [...CURSOR_PERMISSION_MODES.modes], appliesFrom: "next-turn" })
  expect(cursorPermissionModeState({ permissionMode: "auto-review" }).currentModeId).toBe("auto-review")
  expect(() => permissionLocalOptions({ permissionMode: "plan" })).toThrow("Unknown Cursor permission mode plan")
})
