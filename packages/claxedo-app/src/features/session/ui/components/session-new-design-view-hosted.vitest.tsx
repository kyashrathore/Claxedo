/**
 * The composer chip row as a HOSTED CLOUD session sees it.
 *
 * The sibling `session-new-design-view.vitest.tsx` pins the project chip's
 * footer action with static mocks (one local project, empty inventory). This
 * file varies the three inputs the hosted path actually turns on — the
 * platform, the control-plane transport, and the inventory SHAPE — because all
 * three composer defects were invisible to a local-project fixture:
 *
 *   1. the project chip read "workspace", the basename of the literal
 *      directory "/workspace" every hosted cloud workspace lives in;
 *   2. the environment chip offered "Local" on web, which the browser can
 *      never run;
 *   3. the workspace chip offered only "create new" for a project that already
 *      had cloud workspaces, because the active-project lookup matched the
 *      snapshot's directory keys but not the bootstrap's workspace-id keys.
 */
import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { ContextChip } from "@/features/session/ui/components/session-context-row"
import { NewSessionDesignView } from "./session-new-design-view"

// An ACCESSOR, not a snapshot: the environment chip's options settle after the
// server-health resource resolves, so a copy taken at first render would miss
// them and every `waitFor` below would poll a stale array.
const captured = vi.hoisted(() => ({ read: (() => []) as () => ContextChip[] }))
// Mutable so each test can pick the pane's directory, the inventory it sees,
// and the platform, without a separate module registry per case.
const state = vi.hoisted(() => ({
  directory: "/workspace",
  projects: [] as unknown[],
  platform: "web" as "web" | "desktop",
  /** What `GET /api/claxedo/health` reports; undefined = the field is absent. */
  localExecution: undefined as boolean | undefined,
}))

vi.mock("@/features/session/ui/components/session-context-row", () => ({
  SessionContextRow: (props: { chips: ContextChip[] }) => {
    captured.read = () => props.chips
    return <div data-testid="context-row" />
  },
}))

vi.mock("@/features/session/app-ports", () => ({
  useShellQueryOptions: () => ({ projects: () => ({ queryKey: ["projects"], queryFn: () => [] }) }),
  useLayout: () => ({ projects: { list: () => [], open: () => {}, createRequests: () => 0, requestCreate: () => {} } }),
  useSDK: () => ({
    get directory() {
      return state.directory
    },
  }),
  useServer: () => ({ url: "https://plane.test", projects: { touch: () => {} } }),
  checkServerHealth: async () => ({ localExecution: state.localExecution }),
  ProjectCreateForm: () => <div data-testid="project-create-form" />,
}))

vi.mock("@tanstack/solid-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/solid-query")>()),
  useQuery: () => ({
    get data() {
      return state.projects
    },
  }),
}))

vi.mock("@solidjs/router", () => ({ useNavigate: () => () => {} }))
vi.mock("@/platform/i18n/provider", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({
    get platform() {
      return state.platform
    },
  }),
}))

const chip = (slot: string) => captured.read().find((item) => item.slot === slot)
const projectChip = () => chip("context-chip-project")
const environmentChip = () => chip("context-chip-environment")
const workspaceChip = () => chip("context-chip-worktree")

/**
 * The server BOOTSTRAP shape (routes/hosted/shell.ts `signedShellProjects`):
 * `workspaces` is keyed by WORKSPACE ID and the directory is a field on the
 * value. Two cloud workspaces so the third select has something to list.
 */
const bootstrapProject = {
  worktree: "ws_1",
  sandboxes: ["ws_1", "ws_2"],
  workspaces: {
    ws_1: {
      id: "ws_1",
      kind: "cloud",
      workspace_name: "main",
      directory: "/workspace",
      repo_url: "https://github.com/claxedo/opencode.git",
    },
    ws_2: {
      id: "ws_2",
      kind: "cloud",
      workspace_name: "feature",
      directory: "/workspace",
      repo_url: "https://github.com/claxedo/opencode.git",
    },
  },
}

/** The client SNAPSHOT shape (data/query/inventory.ts): keyed by directory. */
const snapshotProject = {
  worktree: "/workspace",
  sandboxes: ["/workspace", "/workspace-2"],
  workspaces: {
    "/workspace": {
      id: "ws_1",
      kind: "cloud",
      workspace_name: "main",
      directory: "/workspace",
      repo_url: "https://github.com/claxedo/opencode.git",
    },
    "/workspace-2": {
      id: "ws_2",
      kind: "cloud",
      workspace_name: "feature",
      directory: "/workspace-2",
      repo_url: "https://github.com/claxedo/opencode.git",
    },
  },
}

const renderView = (props?: {
  worktree?: string
  workspaceKind?: "local" | "cloud"
  signedControlPlane?: boolean
  sandboxEnabled?: boolean
}) =>
  render(() => (
    <NewSessionDesignView
      worktree={props?.worktree ?? "main"}
      workspaceKind={props?.workspaceKind ?? "cloud"}
      signedControlPlane={props?.signedControlPlane ?? true}
      sandboxEnabled={props?.sandboxEnabled}
      onWorktreeChange={() => {}}
      onWorkspaceKindChange={() => {}}
    >
      <div />
    </NewSessionDesignView>
  ))

afterEach(() => {
  captured.read = () => []
  state.localExecution = undefined
  state.directory = "/workspace"
  state.projects = []
  state.platform = "web"
  cleanup()
})

describe("hosted cloud project label", () => {
  test("shows the project name, never the '/workspace' directory basename", () => {
    state.projects = [{ ...bootstrapProject, name: "claxedo/opencode" }]
    renderView()
    expect(projectChip()?.label).toBe("claxedo/opencode")
    expect(projectChip()?.label).not.toBe("workspace")
  })

  // The name is not always carried: a bootstrap row without repo metadata on
  // the project still has it on the workspaces. Deriving owner/repo there is
  // what keeps the chip off the basename — the same fallback the rail uses.
  test("derives owner/repo from the workspaces when the project has no name", () => {
    state.projects = [bootstrapProject]
    renderView()
    expect(projectChip()?.label).toBe("claxedo/opencode")
  })

  test("derives the label on the directory-keyed snapshot shape too", () => {
    state.projects = [snapshotProject]
    renderView()
    expect(projectChip()?.label).toBe("claxedo/opencode")
  })

  // The guarantee the bug report is really about: whatever else is missing, the
  // chip must not read "workspace" while better data is in the inventory.
  test("never labels a hosted cloud project 'workspace'", () => {
    for (const projects of [
      [bootstrapProject],
      [snapshotProject],
      [{ ...bootstrapProject, name: "claxedo/opencode" }],
    ]) {
      state.projects = projects
      renderView()
      expect(projectChip()?.label).not.toBe("workspace")
      cleanup()
    }
  })

  // With genuinely nothing to derive from, the basename is still the honest
  // last resort — this pins that the fallback was not removed.
  test("falls back to the basename when no repo identity exists anywhere", () => {
    state.directory = "/repo/thing"
    state.projects = [{ worktree: "/repo/thing", workspaces: { "/repo/thing": { kind: "local" } } }]
    renderView({ workspaceKind: "local" })
    expect(projectChip()?.label).toBe("thing")
  })
})

describe("environment options", () => {
  test("web offers cloud only", () => {
    state.platform = "web"
    state.projects = [bootstrapProject]
    renderView({ signedControlPlane: true })
    expect(environmentChip()?.options?.map((option) => option.value)).toEqual(["cloud"])
  })

  // The desktop's embedded server, and a self-hosted server on a machine
  // with a filesystem, report `localExecution: true`; that report — not the
  // platform — is what keeps "Local" beside "Cloud" on a signed plane.
  test("a signed server that executes locally keeps local and cloud", async () => {
    state.platform = "desktop"
    state.localExecution = true
    state.projects = [bootstrapProject]
    renderView({ signedControlPlane: true })
    await vi.waitFor(() => {
      expect(environmentChip()?.options?.map((option) => option.value)).toEqual(["local", "cloud"])
    })
  })

  test("a signed server without local execution offers cloud only, even on desktop", async () => {
    state.platform = "desktop"
    state.localExecution = false
    state.projects = [bootstrapProject]
    renderView({ signedControlPlane: true })
    await vi.waitFor(() => {
      expect(environmentChip()?.options?.map((option) => option.value)).toEqual(["cloud"])
    })
  })

  // Web against a LOOPBACK control plane is the dev/embedded composition, which
  // does have a local machine — the gate is web AND signed, never web alone.
  test("web on a loopback control plane keeps both", () => {
    state.platform = "web"
    state.projects = [bootstrapProject]
    renderView({ signedControlPlane: false })
    expect(environmentChip()?.options?.map((option) => option.value)).toEqual(["local", "cloud"])
  })

  test("hides cloud from the composer when sandbox creation is disabled", () => {
    state.platform = "web"
    state.projects = [bootstrapProject]
    renderView({ signedControlPlane: false, sandboxEnabled: false })
    expect(environmentChip()?.options?.map((option) => option.value)).toEqual(["local"])
  })
})

describe("existing cloud workspaces in the workspace chip", () => {
  // The reported defect: cloud selected, the project HAS cloud workspaces, and
  // the third select offered no way to pick one.
  test("lists the project's existing cloud workspaces on the bootstrap shape", () => {
    state.projects = [bootstrapProject]
    renderView({ workspaceKind: "cloud" })
    expect(workspaceChip()?.options?.map((option) => option.label)).toEqual(["main", "feature"])
  })

  test("lists them on the directory-keyed snapshot shape too", () => {
    state.projects = [snapshotProject]
    renderView({ workspaceKind: "cloud" })
    expect(workspaceChip()?.options?.map((option) => option.label)).toEqual(["main", "feature"])
  })

  // Choosing an existing workspace and creating a new one must stay distinct:
  // the create path is the chip's footer action, not a list entry.
  test("keeps 'new cloud sandbox' as a footer action beside the existing ones", () => {
    state.projects = [bootstrapProject]
    renderView({ workspaceKind: "cloud" })
    expect(workspaceChip()?.options?.length).toBe(2)
    expect(workspaceChip()?.action?.label).toBe("New cloud sandbox")
  })

  // The pre-fix behaviour, pinned as the honest empty case: with no cloud
  // workspace to offer, collapsing to the create path is correct.
  test("offers no options when the project genuinely has no cloud workspace", () => {
    state.directory = "/repo/thing"
    state.projects = [{ worktree: "/repo/thing", workspaces: { "/repo/thing": { kind: "local" } } }]
    renderView({ workspaceKind: "cloud" })
    expect(workspaceChip()?.options).toEqual([])
  })
})

describe("project option detail", () => {
  // A hosted project's option value is a workspace placeholder ("ws_1" on the
  // bootstrap shape, "/workspace" on the snapshot shape) — showing it under the
  // row would put a workspace identity on a project entry. The project id is
  // the disambiguator.
  test("hosted bootstrap rows show the project id, not the workspace placeholder", () => {
    state.projects = [{ ...bootstrapProject, id: "prj_ws_1" }]
    renderView()
    expect(projectChip()?.options?.find((option) => option.value === "ws_1")?.detail).toBe("prj_ws_1")
  })

  test("hosted snapshot rows show the project id, not '/workspace'", () => {
    state.projects = [{ ...snapshotProject, id: "prj_1" }]
    renderView()
    expect(projectChip()?.options?.find((option) => option.value === "/workspace")?.detail).toBe("prj_1")
  })

  test("local rows keep the path as the detail", () => {
    state.directory = "/repo/thing"
    state.projects = [{ worktree: "/repo/thing", workspaces: { "/repo/thing": { kind: "local" } } }]
    renderView({ workspaceKind: "local" })
    expect(projectChip()?.options?.find((option) => option.value === "/repo/thing")?.detail).toBe("/repo/thing")
  })
})
