import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { ContextChip } from "@/features/session/ui/components/session-context-row"
import { NewSessionDesignView } from "./session-new-design-view"

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
  // The local product's server answers no `localExecution` field; the view
  // then falls back to "unsigned means local".
  checkServerHealth: async () => undefined,
  ProjectCreateForm: (props: { localExecution: boolean }) => (
    <div data-testid="project-create-form" data-local-execution={String(props.localExecution)} />
  ),
}))

vi.mock("@tanstack/solid-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/solid-query")>()),
  useQuery: () => ({
    get data() {
      return state.projects
    },
  }),
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

const renderView = () =>
  render(() => (
    <NewSessionDesignView
      worktree="/repo"
      workspaceKind="local"
      onWorktreeChange={() => {}}
      onWorkspaceKindChange={() => {}}
    >
      <div />
    </NewSessionDesignView>
  ))

afterEach(() => {
  captured.chips = []
  state.projects = []
  cleanup()
})

describe("NewSessionDesignView project chip create panel", () => {
  test("labels the project option group", () => {
    renderView()
    expect(projectChip()?.groupLabel).toBe("Projects")
  })

  // Creation lives IN the chip: the footer opens a panel with the create
  // form, so there is no separate "add project" action to dispatch.
  test("offers 'Create project…' as the chip's panel, not a footer action", () => {
    renderView()
    expect(projectChip()?.action).toBeUndefined()
    expect(projectChip()?.panel?.label).toBe("Create project…")
  })

  test("the panel renders the project create form for a local server", async () => {
    renderView()
    const panel = projectChip()?.panel
    expect(panel).toBeDefined()
    const host = render(() => <>{panel!.render({ close: () => {}, back: () => {}, hold: () => {} })}</>)
    await vi.waitFor(() => {
      expect(host.getByTestId("project-create-form").getAttribute("data-local-execution")).toBe("true")
    })
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
        branch={{ gitRef: "main", sourceBranch: "main" }}
        branches={[
          { gitRef: "main", sourceBranch: "main" },
          { gitRef: "origin/release/next", sourceBranch: "release/next" },
        ]}
        branchState="ready"
        onBranchChange={onBranchChange}
        onWorktreeChange={() => {}}
        onWorkspaceKindChange={() => {}}
      >
        <div />
      </NewSessionDesignView>
    ))

    expect(branchChip()?.ariaLabel).toBe("Base branch")
    expect(branchChip()?.options).toEqual([
      { value: "main", label: "main", detail: undefined },
      { value: "origin/release/next", label: "release/next", detail: "origin/release/next" },
    ])
    branchChip()?.onSelect("origin/release/next")
    expect(onBranchChange).toHaveBeenCalledWith("origin/release/next")
  })

  test.each([
    ["loading", "Loading branches…", "No branches"],
    ["error", "Branches unavailable", "Could not load branches"],
  ] as const)("renders an explicit %s state without a selectable synthetic ref", (status, label, emptyMessage) => {
    render(() => (
      <NewSessionDesignView
        worktree="/repo"
        workspaceKind="local"
        branchState={status}
        onBranchChange={() => {}}
        onWorktreeChange={() => {}}
        onWorkspaceKindChange={() => {}}
      >
        <div />
      </NewSessionDesignView>
    ))

    expect(branchChip()?.label).toBe(label)
    expect(branchChip()?.emptyMessage).toBe(emptyMessage)
    expect(branchChip()?.options).toEqual([])
    expect(branchChip()?.disabled).toBe(true)
  })

  test("offers cloud provisioning only for branches proven on origin", () => {
    render(() => (
      <NewSessionDesignView
        worktree="create"
        workspaceKind="cloud"
        branch={{ gitRef: "local-only" }}
        branches={[
          { gitRef: "local-only" },
          { gitRef: "upstream/feature/e2e" },
          { gitRef: "origin/release/next", sourceBranch: "release/next" },
        ]}
        branchState="ready"
        onBranchChange={() => {}}
        onWorktreeChange={() => {}}
        onWorkspaceKindChange={() => {}}
      >
        <div />
      </NewSessionDesignView>
    ))

    expect(branchChip()?.label).toBe("Default branch")
    expect(branchChip()?.current).toBeUndefined()
    expect(branchChip()?.options).toEqual([
      { value: "origin/release/next", label: "release/next", detail: "origin/release/next" },
    ])
  })

  test("does not render a decorative branch control without a selection owner", () => {
    renderView()
    expect(branchChip()).toBeUndefined()
  })
})
