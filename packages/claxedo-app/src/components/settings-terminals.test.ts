import { beforeEach, describe, expect, test } from "bun:test"
import { getTerminalCommands } from "./settings-terminals"

const key = "claxedo.terminalCommands"

beforeEach(() => {
  localStorage.clear()
})

describe("terminal settings", () => {
  test("falls back to default commands when storage is empty or invalid", () => {
    expect(getTerminalCommands()).toMatchObject({
      claude: "claude --dangerously-skip-permissions",
      codex: 'codex -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access',
      custom: [],
    })

    localStorage.setItem(key, "{")
    expect(getTerminalCommands().custom).toEqual([])
  })

  test("keeps only well-formed custom commands from storage", () => {
    localStorage.setItem(
      key,
      JSON.stringify({
        claude: "claude --print",
        codex: "codex exec",
        custom: [
          { id: "valid", name: "Aider", command: "aider" },
          { id: "bad-name", name: 42, command: "broken" },
          { id: "bad-command", name: "Broken" },
          null,
        ],
      }),
    )

    expect(getTerminalCommands()).toEqual({
      claude: "claude --print",
      codex: "codex exec",
      custom: [{ id: "valid", name: "Aider", command: "aider" }],
    })
  })
})
