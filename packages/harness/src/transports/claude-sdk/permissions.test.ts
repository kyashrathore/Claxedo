import { expect, test } from "bun:test"
import { denyFloor, modeParity, modes, permissionOptions, sdkModes } from "./permissions"

const config = { harness: { id: "claude", access: "native" } } as const

test("the selectable SDK mode set is pinned and unique", () => {
  expect(modeParity).toBe(true)
  expect(sdkModes).toEqual(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"])
  expect(new Set(modes.map((mode) => mode.id)).size).toBe(modes.length)
})

test("bypass mode still carries the native deny floor and exact accepted rules", () => {
  const options = permissionOptions({ ...config, permissionMode: "bypassPermissions", permissionState: {
    allow: ["Bash(echo (hello))"], deny: ["Write"], ask: [], additionalDirectories: ["/tmp/approved"],
  } })
  expect(options.permissionMode).toBe("bypassPermissions")
  expect(options.allowDangerouslySkipPermissions).toBe(true)
  expect(options.settings.permissions.allow).toEqual(["Bash(echo (hello))"])
  expect(options.settings.permissions.deny).toEqual(["Write", ...denyFloor])
  expect(options.additionalDirectories).toEqual(["/tmp/approved"])
})

test("invalid persisted permission state and unknown mode fail before launch", () => {
  expect(() => permissionOptions({ ...config, permissionState: { allow: "Bash(*)" } })).toThrow("Invalid Claude allow")
  expect(() => permissionOptions({ ...config, permissionMode: "unknown" })).toThrow("Unknown Claude permission mode")
})
