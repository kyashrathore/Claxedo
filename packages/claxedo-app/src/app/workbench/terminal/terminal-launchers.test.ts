import { describe, expect, test } from "bun:test"
import { defaultTerminalCommands } from "@/features/terminal/core/terminal-commands"
import { terminalLaunchers } from "./terminal-launchers"

const ids = (installed?: readonly string[]) =>
  terminalLaunchers(defaultTerminalCommands(), installed).map((launcher) => launcher.id)

describe("terminalLaunchers", () => {
  test("offers the shell first, then every catalog agent, in catalog order", () => {
    expect(ids()).toEqual(["shell", "claude", "codex", "cursor", "gemini"])
  })

  test("offers only the agents whose CLI the machine reported", () => {
    expect(ids(["codex"])).toEqual(["shell", "codex"])
  })

  /** Cursor's CLI is `cursor-agent`; the older `cursor` name means the same tile. */
  test("matches an agent on any binary name it answers to", () => {
    expect(ids(["cursor"])).toEqual(["shell", "cursor"])
    expect(ids(["cursor-agent"])).toEqual(["shell", "cursor"])
  })

  test("an empty report hides every agent, an absent one hides none", () => {
    expect(ids([])).toEqual(["shell"])
    expect(ids(undefined)).toEqual(["shell", "claude", "codex", "cursor", "gemini"])
  })

  test("keeps custom commands regardless of the report, and skips half-filled rows", () => {
    const commands = {
      ...defaultTerminalCommands(),
      custom: [
        { id: "a", name: "Aider", command: "aider --model gpt-4" },
        { id: "b", name: "", command: "goose" },
        { id: "c", name: "Cline", command: "  " },
      ],
    }

    expect(terminalLaunchers(commands, []).map((launcher) => launcher.id)).toEqual(["shell", "custom:a"])
  })

  test("a blank agent command drops that agent rather than launching a no-op", () => {
    const commands = defaultTerminalCommands()
    commands.agents.claude = "   "

    expect(terminalLaunchers(commands).map((launcher) => launcher.id)).toEqual([
      "shell",
      "codex",
      "cursor",
      "gemini",
    ])
  })

  test("the shell launcher carries no command, so it is not spawned as one", () => {
    expect(terminalLaunchers(defaultTerminalCommands())[0]).toEqual({
      id: "shell",
      name: "Shell",
      icon: "terminal",
    })
  })
})
