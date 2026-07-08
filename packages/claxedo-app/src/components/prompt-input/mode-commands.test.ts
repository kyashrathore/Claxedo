import { describe, expect, test } from "bun:test"
import {
  promptNormalModeKey,
  promptShellModeKey,
  registerPromptModeCommands,
  type PromptComposerEditMode,
  type PromptModeCommand,
} from "./mode-commands"

describe("prompt mode commands", () => {
  const labels = {
    attachFile: "Attach file",
    fileCategory: "File",
    shellMode: "Shell mode",
    normalMode: "Normal mode",
    sessionCategory: "Session",
  }

  test("registers attach, shell, and normal mode commands", () => {
    let mode: PromptComposerEditMode = "normal"
    const registrations: Array<{ scope: string; commands: () => PromptModeCommand[] }> = []
    const attached: string[] = []

    registerPromptModeCommands({
      register: (scope, commands) => registrations.push({ scope, commands }),
      mode: () => mode,
      pick: () => attached.push("file"),
      setMode: (next) => {
        mode = next
      },
      labels,
    })

    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.scope).toBe("prompt-input")

    const normalCommands = registrations[0]!.commands()
    expect(normalCommands.map((command) => command.id)).toEqual([
      "file.attach",
      "prompt.mode.shell",
      "prompt.mode.normal",
    ])
    expect(normalCommands[0]?.disabled).toBe(false)
    expect(normalCommands[1]?.keybind).toBe(promptShellModeKey)
    expect(normalCommands[1]?.disabled).toBe(false)
    expect(normalCommands[2]?.keybind).toBe(promptNormalModeKey)
    expect(normalCommands[2]?.disabled).toBe(true)

    normalCommands[0]?.onSelect()
    normalCommands[1]?.onSelect()

    expect(attached).toEqual(["file"])
    expect(mode).toBe("shell")

    const shellCommands = registrations[0]!.commands()
    expect(shellCommands[0]?.disabled).toBe(true)
    expect(shellCommands[1]?.disabled).toBe(true)
    expect(shellCommands[2]?.disabled).toBe(false)

    shellCommands[2]?.onSelect()
    expect(mode).toBe("normal")
  })
})
