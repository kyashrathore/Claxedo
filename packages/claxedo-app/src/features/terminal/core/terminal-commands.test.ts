import { beforeEach, describe, expect, test } from "bun:test"
import { getTerminalCommands, saveTerminalCommands } from "./terminal-commands"

const key = "claxedo.terminalCommands"

beforeEach(() => {
  localStorage.clear()
})

describe("terminal commands", () => {
  test("falls back to default commands when storage is empty or invalid", () => {
    expect(getTerminalCommands()).toEqual({
      agents: {
        claude: "claude --dangerously-skip-permissions",
        codex: 'codex -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access',
        cursor: "cursor-agent",
        gemini: "gemini",
      },
      custom: [],
    })

    localStorage.setItem(key, "{")
    expect(getTerminalCommands().custom).toEqual([])
  })

  /**
   * The stored shape predates the catalog: a profile that only ever saved
   * claude and codex must keep those two and pick up defaults for the rest,
   * rather than reverting the pair the user edited.
   */
  test("keeps commands saved before an agent joined the catalog", () => {
    localStorage.setItem(key, JSON.stringify({ claude: "claude --print", codex: "codex exec", custom: [] }))

    expect(getTerminalCommands().agents).toEqual({
      claude: "claude --print",
      codex: "codex exec",
      cursor: "cursor-agent",
      gemini: "gemini",
    })
  })

  test("keeps only well-formed custom commands from storage", () => {
    localStorage.setItem(
      key,
      JSON.stringify({
        custom: [
          { id: "valid", name: "Aider", command: "aider" },
          { id: "bad-name", name: 42, command: "broken" },
          { id: "bad-command", name: "Broken" },
          null,
        ],
      }),
    )

    expect(getTerminalCommands().custom).toEqual([{ id: "valid", name: "Aider", command: "aider" }])
  })

  test("saves flat by agent id, so a reload reads back what was written", () => {
    saveTerminalCommands({
      agents: { claude: "claude", codex: "codex", cursor: "cursor-agent --foo", gemini: "gemini -p" },
      custom: [{ id: "c1", name: "Aider", command: "aider" }],
    })

    expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual({
      claude: "claude",
      codex: "codex",
      cursor: "cursor-agent --foo",
      gemini: "gemini -p",
      custom: [{ id: "c1", name: "Aider", command: "aider" }],
    })
    expect(getTerminalCommands().agents.cursor).toBe("cursor-agent --foo")
  })
})
