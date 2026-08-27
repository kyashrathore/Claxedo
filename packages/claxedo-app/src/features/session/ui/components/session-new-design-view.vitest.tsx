import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { ContextChip } from "@/features/session/ui/components/session-context-row"
import { NewSessionDesignView } from "./session-new-design-view"
import { ADD_PROJECT_COMMAND_ID, addProjectAction } from "./session-add-project-action"

const captured = vi.hoisted(() => ({ chips: [] as ContextChip[] }))
const state = vi.hoisted(() => ({ projects: [] as unknown[] }))

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
  useQuery: () => ({ get data() { return state.projects } }),
}))

vi.mock("@solidjs/router", () => ({
  useNavigate: () => () => {},
}))

// The environment chip's options depend on the platform (web offers cloud
// only — there is no local machine behind the renderer). These cases are about
// the PROJECT chip, so pin desktop and let the hosted-composition cases live in
// session-new-design-view-hosted.vitest.tsx.
vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ platform: "desktop" }),
}))

// A pass-through `t` would be indistinguishable from the hardcoded English
// string, so the fake echoes the key instead: the assertion then proves the
// label really came out of the locale table.
vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => `t:${key}` }),
}))

const projectChip = () => captured.chips.find((chip) => chip.slot === "context-chip-project")
const branchChip = () => captured.chips.find((chip) => chip.slot === "context-chip-branch")

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
  state.projects = []
  cleanup()
})

describe("NewSessionDesignView project chip footer action", () => {
  test("labels the project option group", () => {
    renderView()
    expect(projectChip()?.groupLabel).toBe("Projects")
  })

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

  test("project selection carries its opaque identity with the directory", () => {
    const onProjectChange = vi.fn()
    const project = { id: "project_2", worktree: "/repo-two", name: "Two" }
    state.projects = [{ id: "project_1", worktree: "/repo", name: "One" }, project]
    render(() => (
      <NewSessionDesignView
        worktree="/repo"
        workspaceKind="local"
        onWorktreeChange={() => {}}
        onWorkspaceKindChange={() => {}}
        onProjectChange={onProjectChange}
      >
        <div />
      </NewSessionDesignView>
    ))

    projectChip()?.onSelect("/repo-two")

    expect(onProjectChange).toHaveBeenCalledWith("/repo-two", project)
  })
})

describe("NewSessionDesignView branch chip", () => {
  test("offers every advertised branch and sends the selected ref to its owner", () => {
    const onBranchChange = vi.fn()
    render(() => (
      <NewSessionDesignView
        worktree="/repo"
        workspaceKind="local"
        branch="main"
        branches={["main", "release/next"]}
        onBranchChange={onBranchChange}
        onWorktreeChange={() => {}}
        onWorkspaceKindChange={() => {}}
      >
        <div />
      </NewSessionDesignView>
    ))

    expect(branchChip()?.ariaLabel).toBe("Base branch")
    expect(branchChip()?.options.map((option) => option.value)).toEqual(["main", "release/next"])
    branchChip()?.onSelect("release/next")
    expect(onBranchChange).toHaveBeenCalledWith("release/next")
  })

  test("does not render a decorative branch control without a selection owner", () => {
    renderView()
    expect(branchChip()).toBeUndefined()
  })
})

describe("addProjectAction", () => {
  test("returns nothing when the app shell has not registered project.open", () => {
    const trigger = vi.fn()
    expect(addProjectAction({ has: () => false, trigger })).toBeUndefined()
    expect(trigger).not.toHaveBeenCalled()
  })

  test("triggers the registered project.open command", () => {
    const trigger = vi.fn()
    const action = addProjectAction({ has: (id) => id === ADD_PROJECT_COMMAND_ID, trigger })
    expect(action).toBeTypeOf("function")
    action?.()
    expect(trigger).toHaveBeenCalledWith(ADD_PROJECT_COMMAND_ID)
  })
})
