import { expect, test } from "bun:test"
import { classifyFirstTurnError } from "@claxedo/agent-runtime-contract"
import { claudeProcessFailed } from "./errors"

test("a Claude Code process that exits names its own last stderr line, never the whole log, and is a harness failure", () => {
  const stderr = "\u001b[33mwarning: config reloaded\u001b[0m\n--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons\n\n"
  const failed = claudeProcessFailed(new Error("Claude Code process exited with code 1"), stderr)
  expect(failed).toMatchObject({
    transport: "claude",
    code: "process",
    message: "Claude Code process exited with code 1: --dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons",
    detail: { stderr },
  })
  expect(classifyFirstTurnError(failed)).toBe("harness")
})

test("a Claude Code process that exits saying it has no login is a credential failure", () => {
  const failed = claudeProcessFailed(new Error("Claude Code process exited with code 1"), "Invalid API key · Please run /login\n")
  expect(classifyFirstTurnError(failed)).toBe("credential")
})

test("a Claude Code process that exits with nothing on stderr keeps the SDK's words", () => {
  expect(claudeProcessFailed(new Error("Claude Code process exited with code 1"), " \n")).toMatchObject({ message: "Claude Code process exited with code 1" })
})

test("a stderr line past 300 characters is cut there", () => {
  const failed = claudeProcessFailed(new Error("Claude Code process exited with code 1"), `${"x".repeat(400)}\n`)
  expect(failed).toMatchObject({ message: `Claude Code process exited with code 1: ${"x".repeat(300)}` })
})
