import { expect, test } from "bun:test"
import { registerPromptModeCommands, type PromptModeCommand } from "./mode-commands"

test("a send share offers attachment commands but cannot enter owner-only shell mode", () => {
  let commands: PromptModeCommand[] = []
  const policy = { shellEnabled: () => false }
  registerPromptModeCommands({
    ...policy,
    register: (_scope, read) => { commands = read() }, mode: () => "normal", pick: () => {}, setMode: () => {},
    goalSelectable: () => false, armGoal: () => {},
    labels: { attachFile: "Attach", fileCategory: "File", shellMode: "Shell", normalMode: "Normal", sessionCategory: "Session", goal: "Goal" },
  })
  expect(commands.find((command) => command.id === "file.attach")?.disabled).toBe(false)
  expect(commands.find((command) => command.id === "prompt.mode.shell")?.disabled).toBe(true)
})
