import { expect, test } from "bun:test"
import { CURSOR_PERMISSION_MODES } from "@claxedo/agent-runtime-contract"
import { cursorPermissionModeState, permissionLocalOptions, protocolPermissionMap } from "./permission-modes"

test("every mode in the contract's Cursor table maps to its own local agent options, and nothing else does", () => {
  expect(Object.keys(protocolPermissionMap).sort()).toEqual(CURSOR_PERMISSION_MODES.modes.map((mode) => mode.id).sort())
})

test("with nothing chosen a Cursor session reports and launches auto-review", () => {
  expect(permissionLocalOptions({})).toEqual({ sandboxOptions: { enabled: true }, autoReview: true })
  expect(cursorPermissionModeState({})).toEqual({ modes: [...CURSOR_PERMISSION_MODES.modes], currentModeId: "auto-review", appliesFrom: "next-turn" })
  expect(permissionLocalOptions({ permissionMode: "unsandboxed" })).toEqual({ sandboxOptions: { enabled: false } })
  expect(() => permissionLocalOptions({ permissionMode: "plan" })).toThrow("Unknown Cursor permission mode plan")
})
