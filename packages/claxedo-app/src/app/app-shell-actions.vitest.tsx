import { createRoot } from "solid-js"
import { describe, expect, test, vi } from "vitest"
import type { CommandOption } from "@/app/providers/command"
import { ADD_PROJECT_COMMAND_ID } from "@/features/session/ui/components/session-add-project-action"
import { useAppShellActions } from "./app-shell-actions"

const stubs = vi.hoisted(() => ({
  handleNewProject: vi.fn(),
  registrations: [] as { key: string; options: () => CommandOption[] }[],
}))

vi.mock("./workbench/actions/index", () => ({
  createClaxedoLayoutActions: () => ({ handleNewProject: stubs.handleNewProject }),
}))

vi.mock("./integrations/claxedo-events", () => ({
  useClaxedoEventsOptional: () => undefined,
}))

vi.mock("@/app/providers/command", () => ({
  useCommand: () => ({
    register: (key: string, options: () => CommandOption[]) => stubs.registrations.push({ key, options }),
  }),
}))

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => `t:${key}` }),
}))

const registeredCommands = () =>
  createRoot((dispose) => {
    useAppShellActions({ shell: { state: {} }, params: {}, navigate: () => {} } as never)
    const options = stubs.registrations.flatMap((registration) => registration.options())
    dispose()
    return options
  })

describe("useAppShellActions", () => {
  test("registers project.open so the desktop menu and the new-session chip can reach handleNewProject", () => {
    const open = registeredCommands().find((option) => option.id === ADD_PROJECT_COMMAND_ID)

    expect(open).toBeDefined()
    expect(open?.title).toBe("t:command.project.open")
    expect(open?.category).toBe("t:command.category.project")

    open?.onSelect?.()
    expect(stubs.handleNewProject).toHaveBeenCalledTimes(1)
  })
})
