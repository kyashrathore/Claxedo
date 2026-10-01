import { expect, test } from "bun:test"
import { connectionGrantKeys } from "../../contract"
import { CLAUDE_PERMISSION_MODES } from "@claxedo/agent-runtime-contract"
import { modeParity, permissionOptions, sdkModes } from "./permissions"
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk"

type IsAny<T> = 0 extends (1 & T) ? true : false
const sdkModeIsARealUnion: IsAny<PermissionMode> extends true ? false : string extends PermissionMode ? false : true = true

const config = { harness: { id: "claude", access: "native" } } as const

test("the selectable SDK mode set is pinned and unique", () => {
  expect(modeParity).toBe(true)
  expect(sdkModeIsARealUnion).toBe(true)
  expect(sdkModes).toEqual(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"])
})

test("the contract's Claude table offers exactly the SDK's modes, and its default launches", () => {
  expect(CLAUDE_PERMISSION_MODES.modes.map((mode) => mode.id).sort()).toEqual([...sdkModes].sort())
  expect(CLAUDE_PERMISSION_MODES.defaultModeId).toBe(permissionOptions(config).permissionMode)
})

test("bypass mode still carries the native deny floor and exact accepted rules", () => {
  const grant = JSON.stringify({ tool: "Bash", updates: [
    { type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Bash", ruleContent: "echo (hello)" }] },
    { type: "addRules", behavior: "deny", destination: "session", rules: [{ toolName: "Write" }] },
    { type: "addDirectories", directories: ["/tmp/approved"], destination: "session" },
  ] })
  const options = permissionOptions({ ...config, permissionMode: "bypassPermissions" }, [grant])
  expect(options.permissionMode).toBe("bypassPermissions")
  expect(options.allowDangerouslySkipPermissions).toBe(true)
  expect(options.settings.permissions.allow).toEqual(["Bash(echo (hello))"])
  expect(options.settings.permissions.deny).toEqual(["Write", "Bash(rm -rf /*)", "Bash(rm -rf ~*)", "Bash(git push --force*)",
    "Bash(curl *| sh)", "Bash(curl *| bash)", "Bash(wget *| sh)", "Bash(chmod -R 777*)"])
  expect(options.additionalDirectories).toEqual(["/tmp/approved"])
})

test("an unknown mode fails before launch", () => {
  expect(() => permissionOptions({ ...config, permissionMode: "unknown" })).toThrow("Unknown Claude permission mode")
})

test("saved grants replay their rules and directories at launch while the runtime keeps the mode", () => {
  const key = (updates: unknown) => JSON.stringify(["claude-sdk", JSON.stringify({ tool: "Bash", directory: "/work", updates })])
  const foreign = JSON.stringify(["codex-app-server", JSON.stringify({ tool: "Bash", directory: "/work", updates: [{ type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Bash", ruleContent: "codex" }] }] })])
  const state = { brokerGrants: [
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
