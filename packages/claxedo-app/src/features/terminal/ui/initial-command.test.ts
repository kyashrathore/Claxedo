import { describe, expect, test } from "bun:test"
import { isAgentLaunchCommand, resolveInitialCommand } from "./initial-command"

// A terminal's persisted initialCommand is auto-typed once — except for agent
// launchers, which the app starts through its own harness. These pin which
// commands get dropped so a reload never spawns a duplicate agent.

describe("isAgentLaunchCommand", () => {
  test.each(["claude", "codex", "gemini", "cursor", "cursor-agent"])(
    "'%s' is recognised as an agent launcher",
    (cmd) => {
      expect(isAgentLaunchCommand(cmd)).toBe(true)
    },
  )

  test("recognises an agent launcher invoked by absolute path with args", () => {
    expect(isAgentLaunchCommand("/usr/local/bin/claude --resume")).toBe(true)
  })

  test("plain shell commands are not agent launchers", () => {
    expect(isAgentLaunchCommand("npm run dev")).toBe(false)
    expect(isAgentLaunchCommand("ls -la")).toBe(false)
  })

  test("empty, whitespace, and undefined input are not agent launchers", () => {
    expect(isAgentLaunchCommand("")).toBe(false)
    expect(isAgentLaunchCommand("   ")).toBe(false)
    expect(isAgentLaunchCommand(undefined)).toBe(false)
  })

  test("a command that merely contains 'claude' as an argument is not a launcher", () => {
    expect(isAgentLaunchCommand("echo claude")).toBe(false)
  })
})

describe("resolveInitialCommand", () => {
  test("a plain command is sent verbatim and the stored value is kept", () => {
    expect(resolveInitialCommand("npm run dev")).toEqual({ command: "npm run dev", clearStored: false })
  })

  test("an agent launcher resolves to no command and requests the stored value be cleared", () => {
    expect(resolveInitialCommand("claude")).toEqual({ command: "", clearStored: true })
  })

  test("undefined and empty resolve to nothing to send and nothing to clear", () => {
    expect(resolveInitialCommand(undefined)).toEqual({ command: "", clearStored: false })
    expect(resolveInitialCommand("")).toEqual({ command: "", clearStored: false })
  })
})
