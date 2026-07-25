import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { ContextChip } from "@/features/session/ui/components/session-context-row"
import { NewSessionDesignView } from "./session-new-design-view"
import { ADD_PROJECT_COMMAND_ID, addProjectAction } from "./session-add-project-action"

const captured = vi.hoisted(() => ({ chips: [] as ContextChip[] }))

vi.mock("@/features/session/ui/components/session-context-row", () => ({
  SessionContextRow: (props: { chips: ContextChip[] }) => {
    captured.chips = props.chips
    return <div data-testid="context-row" />
  },
}))

vi.mock("@/features/session/app-ports", () => ({
  useShellQueryOptions: () => ({ projects: () => ({ queryKey: ["projects"], queryFn: () => [] }) }),
  useLayout: () => ({ projects: { list: () => [], open: () => {} } }),
  useSDK: () => ({ directory: "/repo" }),
  useServer: () => ({ projects: { touch: () => {} } }),
}))

vi.mock("@tanstack/solid-query", () => ({
  useQuery: () => ({ data: [] }),
}))

vi.mock("@solidjs/router", () => ({
  useNavigate: () => () => {},
}))

// A pass-through `t` would be indistinguishable from the hardcoded English
// string, so the fake echoes the key instead: the assertion then proves the
// label really came out of the locale table.
vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => `t:${key}` }),
}))

const projectChip = () => captured.chips.find((chip) => chip.slot === "context-chip-project")

const renderView = (onAddProject?: () => void) =>
  render(() => (
    <NewSessionDesignView
      worktree="/repo"
      workspaceKind="local"
      onWorktreeChange={() => {}}
      onWorkspaceKindChange={() => {}}
      onAddProject={onAddProject}
    >
      <div />
    </NewSessionDesignView>
  ))

afterEach(() => {
  captured.chips = []
  cleanup()
})

describe("NewSessionDesignView project chip footer action", () => {
  test("omits the footer row when no add-project capability is supplied", () => {
    renderView(undefined)
    expect(projectChip()?.action).toBeUndefined()
  })

  test("labels the footer row from the locale table, not a hardcoded string", () => {
    renderView(() => {})
    expect(projectChip()?.action?.label).toBe("t:home.project.add")
  })

  test("footer row onSelect invokes the supplied capability", () => {
    const addProject = vi.fn()
    renderView(addProject)
    projectChip()?.action?.onSelect()
    expect(addProject).toHaveBeenCalledTimes(1)
  })
})

describe("addProjectAction", () => {
  test("returns nothing when the app shell has not registered project.open", () => {
    const trigger = vi.fn()
    expect(addProjectAction({ options: [{ id: "session.new" }], trigger })).toBeUndefined()
    expect(trigger).not.toHaveBeenCalled()
  })

  test("triggers the registered project.open command", () => {
    const trigger = vi.fn()
    const action = addProjectAction({ options: [{ id: ADD_PROJECT_COMMAND_ID }], trigger })
    expect(action).toBeTypeOf("function")
    action?.()
    expect(trigger).toHaveBeenCalledWith(ADD_PROJECT_COMMAND_ID)
  })
})
