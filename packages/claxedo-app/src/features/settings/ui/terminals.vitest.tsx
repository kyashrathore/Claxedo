import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const toast = vi.fn()
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: (...args: unknown[]) => toast(...args) }))

// The pane reads the catalog and the saved commands through settings' ports;
// this mock supplies the real terminal-core owners the app composes there.
vi.mock("@/features/settings/app-ports", async () => {
  const agents = await import("@/features/terminal/core/terminal-agents")
  const commands = await import("@/features/terminal/core/terminal-commands")
  return {
    terminalAgents: () => agents.TERMINAL_AGENTS,
    getTerminalCommands: commands.getTerminalCommands,
    saveTerminalCommands: commands.saveTerminalCommands,
    defaultTerminalCommands: commands.defaultTerminalCommands,
  }
})

const { SettingsTerminals } = await import("./terminals")

const key = "claxedo.terminalCommands"

beforeEach(() => {
  localStorage.clear()
  toast.mockClear()
})

afterEach(() => cleanup())

const saved = () => JSON.parse(localStorage.getItem(key) ?? "null") as Record<string, unknown> | null

describe("SettingsTerminals", () => {
  test("edits every catalog agent's command, not just the first two", () => {
    render(() => <SettingsTerminals />)

    const gemini = screen.getByPlaceholderText("gemini") as HTMLInputElement
    fireEvent.input(gemini, { target: { value: "gemini --yolo" } })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    expect(saved()?.gemini).toBe("gemini --yolo")
    expect(saved()?.claude).toBe("claude --dangerously-skip-permissions")
  })

  /** Save stays disabled until something differs, so a no-op cannot write. */
  test("enables Save only once an edit diverges from what is stored", () => {
    render(() => <SettingsTerminals />)

    const save = screen.getByRole("button", { name: "Save Changes" })
    expect(save).toBeDisabled()

    fireEvent.input(screen.getByPlaceholderText("gemini"), { target: { value: "gemini -p" } })
    expect(save).not.toBeDisabled()
  })

  test("adds a custom command and reports the save", () => {
    render(() => <SettingsTerminals />)

    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    fireEvent.input(screen.getByPlaceholderText("Command name (e.g., Aider)"), { target: { value: "Aider" } })
    fireEvent.input(screen.getByPlaceholderText("Command to run (e.g., aider --model gpt-4)"), {
      target: { value: "aider --model gpt-4" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    expect(saved()?.custom).toEqual([{ id: expect.any(String), name: "Aider", command: "aider --model gpt-4" }])
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Terminal commands saved" }))
  })

  test("Reset to Defaults restores every agent command and drops customs", () => {
    localStorage.setItem(key, JSON.stringify({
      claude: "claude --print",
      gemini: "gemini -p",
      custom: [{ id: "a", name: "Aider", command: "aider" }],
    }))
    render(() => <SettingsTerminals />)

    fireEvent.click(screen.getByRole("button", { name: "Reset to Defaults" }))
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    expect(saved()).toEqual({
      claude: "claude --dangerously-skip-permissions",
      codex: 'codex -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access',
      cursor: "cursor-agent",
      gemini: "gemini",
      custom: [],
    })
  })
})
