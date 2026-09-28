import { expect, test } from "bun:test"
import { connectionGrantKeys } from "../../contract"
import { modeParity, modes, permissionOptions, sdkModes } from "./permissions"

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
  expect(options.settings.permissions.deny).toEqual(["Write", "Bash(rm -rf /*)", "Bash(rm -rf ~*)", "Bash(git push --force*)",
    "Bash(curl *| sh)", "Bash(curl *| bash)", "Bash(wget *| sh)", "Bash(chmod -R 777*)"])
  expect(options.additionalDirectories).toEqual(["/tmp/approved"])
})

test("invalid persisted permission state and unknown mode fail before launch", () => {
  expect(() => permissionOptions({ ...config, permissionState: { allow: "Bash(*)" } })).toThrow("Invalid Claude allow")
  expect(() => permissionOptions({ ...config, permissionMode: "unknown" })).toThrow("Unknown Claude permission mode")
})

test("saved grants replay their rules and directories at launch while the runtime keeps the mode", () => {
  const key = (updates: unknown) => JSON.stringify(["claude-sdk", JSON.stringify({ tool: "Bash", directory: "/work", updates })])
  const foreign = JSON.stringify(["codex-app-server", JSON.stringify({ tool: "Bash", directory: "/work", updates: [{ type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Bash", ruleContent: "codex" }] }] })])
  const state = { allow: ["Read"], brokerGrants: [
    key([{ type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Bash", ruleContent: "npm test" }] }]),
    key([{ type: "setMode", mode: "acceptEdits", destination: "session" }, { type: "addDirectories", directories: ["/tmp/extra"], destination: "session" }]),
    key([{ type: "removeRules", behavior: "allow", destination: "session", rules: [{ toolName: "Read" }] }]),
    foreign,
  ] }
  const options = permissionOptions({ ...config, permissionMode: "default", permissionState: state }, connectionGrantKeys(state, "claude-sdk"))
  expect(options.permissionMode).toBe("default")
  expect(options.settings.permissions.allow).toEqual(["Bash(npm test)"])
  expect(options.additionalDirectories).toEqual(["/tmp/extra"])
  expect(() => permissionOptions({ ...config, permissionState: state }, ["not json"])).toThrow("Invalid persisted Claude grant")
})

test("an unselected Claude session runs in the auto classifier mode", () => {
  expect(permissionOptions(config).permissionMode).toBe("auto")
})
