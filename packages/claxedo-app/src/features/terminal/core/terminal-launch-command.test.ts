import { describe, expect, test } from "bun:test"
import { terminalLaunchCommand } from "./terminal-launch-command"

describe("terminalLaunchCommand", () => {
  test("parses supported agent commands", () => {
    expect(terminalLaunchCommand("codex --model gpt-5")).toEqual({
      command: "codex",
      args: ["--model", "gpt-5"],
    })
  })

  test("rejects unsupported commands and shell operators", () => {
    expect(terminalLaunchCommand("bash script.sh")).toBeUndefined()
    expect(terminalLaunchCommand("codex && echo done")).toBeUndefined()
  })
})
