import { describe, expect, test } from "bun:test"
import {
  CREATE_WORKTREE,
  createNewSessionWorkspaceState,
  findProjectForDirectory,
  MAIN_WORKTREE,
  newSessionEnvironmentOptions,
  repoDerivedProjectLabel,
} from "./session-new-workspace-options"

const workspaces = {
  "/repo/main": { kind: "local" },
  "/repo/local-feature": { kind: "local" },
  "workspace:cloud-main": { kind: "cloud", workspace_name: "main" },
  "workspace:cloud-feature": { kind: "cloud", workspace_name: "feature" },
} as const

describe("createNewSessionWorkspaceState", () => {
  test("filters local and cloud workspace choices separately", () => {
    const sandboxes = ["/repo/local-feature", "workspace:cloud-main", "workspace:cloud-feature"]

    expect(createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: MAIN_WORKTREE,
      workspaceKind: "local",
      sandboxes,
      workspaces,
    }).options).toEqual([MAIN_WORKTREE, "/repo/local-feature"])

    expect(createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: "workspace:cloud-main",
      workspaceKind: "cloud",
      sandboxes,
      workspaces,
    }).options).toEqual(["workspace:cloud-main", "workspace:cloud-feature"])
  })

  test("keeps create-new mutually exclusive from selecting an existing workspace", () => {
    const state = createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: CREATE_WORKTREE,
      workspaceKind: "local",
      sandboxes: ["/repo/local-feature"],
      workspaces,
    })

    expect(state.creatingWorkspace).toBe(true)
    expect(state.currentWorktree).toBe(MAIN_WORKTREE)
  })

  test("cloud mode defaults to create-new when no cloud workspace exists", () => {
    const state = createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: MAIN_WORKTREE,
      workspaceKind: "cloud",
      sandboxes: ["/repo/local-feature"],
      workspaces: {
        "/repo/main": { kind: "local" },
        "/repo/local-feature": { kind: "local" },
      },
    })

    expect(state.options).toEqual([])
    expect(state.currentWorktree).toBeUndefined()
    expect(state.creatingWorkspace).toBe(true)
  })

  test("classifies raw and prefixed workspace refs as cloud choices", () => {
    expect(createNewSessionWorkspaceState({
      projectRoot: "ws_raw",
      selectedWorktree: MAIN_WORKTREE,
      workspaceKind: "cloud",
    }).options).toEqual([MAIN_WORKTREE])

    expect(createNewSessionWorkspaceState({
      projectRoot: "workspace:ws_prefixed",
      selectedWorktree: MAIN_WORKTREE,
      workspaceKind: "cloud",
    }).options).toEqual([MAIN_WORKTREE])

    expect(createNewSessionWorkspaceState({
      projectRoot: "workspace:ws_prefixed",
      selectedWorktree: MAIN_WORKTREE,
      workspaceKind: "local",
    }).options).toEqual([])
  })

  // Regression for the accidental-VM bug: a self-hosted (user-hosted) workspace
  // is its OWN kind and must never be collapsed into "cloud" — collapsing is what
  // dropped it into the cloud-provision create path.
  test("self-hosted workspaces are a distinct kind, never collapsed to cloud", () => {
    const userHostedWorkspaces = {
      "/repo/main": { kind: "local" as const },
      "workspace:self-hosted": { kind: "user-hosted" as const, workspace_name: "my-machine" },
    }
    const sandboxes = ["workspace:self-hosted"]

    // It appears ONLY under the user-hosted kind...
    expect(createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: "workspace:self-hosted",
      workspaceKind: "user-hosted",
      sandboxes,
      workspaces: userHostedWorkspaces,
    }).options).toEqual(["workspace:self-hosted"])

    // ...and is NOT offered as a cloud choice.
    expect(createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: MAIN_WORKTREE,
      workspaceKind: "cloud",
      sandboxes,
      workspaces: userHostedWorkspaces,
    }).options).toEqual([])
  })

  // The fail-closed property: an empty user-hosted option set must NOT auto-flip
  // into create mode (that path only exists for "cloud"). No silent provisioning.
  test("user-hosted with no options never enters create-new mode", () => {
    const state = createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: MAIN_WORKTREE,
      workspaceKind: "user-hosted",
      sandboxes: [],
      workspaces: { "/repo/main": { kind: "local" } },
    })

    expect(state.creatingWorkspace).toBe(false)
  })

  test("excludes unavailable workspace choices", () => {
    expect(createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: "workspace:cloud-main",
      workspaceKind: "cloud",
      sandboxes: ["workspace:cloud-main", "workspace:cloud-feature"],
      workspaces: {
        ...workspaces,
        "workspace:cloud-main": { kind: "cloud", workspace_name: "main", available: false },
      },
    }).options).toEqual(["workspace:cloud-feature"])
  })
})

describe("newSessionEnvironmentOptions", () => {
  // The web build has no local machine behind the renderer, so "Local" was an
  // option the user could pick but that could never resolve to a workspace.
  test("offers cloud only on hosted web", () => {
    expect(newSessionEnvironmentOptions({ platform: "web", signedControlPlane: true }))
      .toEqual(["cloud"])
  })

  test("keeps both options on desktop", () => {
    expect(newSessionEnvironmentOptions({ platform: "desktop", signedControlPlane: true }))
      .toEqual(["local", "cloud"])
  })

  // A desktop app pointed at its own embedded (loopback) server is NOT the
  // hosted composition — the gate is web AND signed, never web alone.
  test("keeps both options when the control plane is loopback", () => {
    expect(newSessionEnvironmentOptions({ platform: "web", signedControlPlane: false }))
      .toEqual(["local", "cloud"])
    expect(newSessionEnvironmentOptions({ platform: "desktop", signedControlPlane: false }))
      .toEqual(["local", "cloud"])
  })
})

describe("repoDerivedProjectLabel", () => {
  test("derives owner/repo from a workspace git remote", () => {
    expect(repoDerivedProjectLabel({
      ws_1: { kind: "cloud", repo_url: "https://github.com/claxedo/opencode.git" },
    })).toBe("claxedo/opencode")
  })

  test("parses the ssh remote form", () => {
    expect(repoDerivedProjectLabel({
      ws_1: { kind: "cloud", repo_url: "git@github.com:claxedo/opencode.git" },
    })).toBe("claxedo/opencode")
  })

  test("prefers an explicit repo_name over the parsed remote", () => {
    expect(repoDerivedProjectLabel({
      ws_1: { kind: "cloud", repo_name: "opencode", repo_url: "https://github.com/other/thing.git" },
    })).toBe("opencode")
  })

  // Falling through to undefined is what lets the caller keep its own
  // basename fallback rather than rendering an empty chip.
  test("returns undefined when no workspace carries repo identity", () => {
    expect(repoDerivedProjectLabel({ ws_1: { kind: "cloud" } })).toBeUndefined()
    expect(repoDerivedProjectLabel(undefined)).toBeUndefined()
  })

  test("skips workspaces with no remote and uses the one that has it", () => {
    expect(repoDerivedProjectLabel({
      ws_bare: { kind: "cloud" },
      ws_repo: { kind: "cloud", repo_url: "https://github.com/claxedo/opencode.git" },
    })).toBe("claxedo/opencode")
  })
})

describe("findProjectForDirectory", () => {
  // The client SNAPSHOT shape: `workspaces` is keyed by directory.
  const directoryKeyed = {
    worktree: "/workspace",
    workspaces: { "/workspace": { kind: "cloud" as const, directory: "/workspace" } },
  }
  // The server BOOTSTRAP shape: `workspaces` is keyed by WORKSPACE ID and the
  // directory is a field on the value. Matching only the key missed this.
  const idKeyed = {
    worktree: "ws_1",
    sandboxes: ["ws_1", "ws_2"],
    workspaces: {
      ws_1: { kind: "cloud" as const, directory: "/workspace", id: "ws_1" },
      ws_2: { kind: "cloud" as const, directory: "/workspace", id: "ws_2" },
    },
  }

  test("resolves the directory-keyed snapshot shape", () => {
    expect(findProjectForDirectory([directoryKeyed], ["/workspace"])).toBe(directoryKeyed)
  })

  test("resolves the ws-id-keyed bootstrap shape by workspace id", () => {
    expect(findProjectForDirectory([idKeyed], ["ws_2"])).toBe(idKeyed)
  })

  // The regression: on the bootstrap shape the pane's directory is "/workspace"
  // but the KEYS are workspace ids, so a key-only match returned undefined —
  // and every chip derives from this lookup.
  test("resolves the ws-id-keyed shape by the directory field on the value", () => {
    expect(findProjectForDirectory([idKeyed], ["/workspace"])).toBe(idKeyed)
  })

  test("matches the worktree and sandboxes", () => {
    expect(findProjectForDirectory([idKeyed], ["ws_1"])).toBe(idKeyed)
  })

  test("returns undefined when nothing matches", () => {
    expect(findProjectForDirectory([directoryKeyed], ["/somewhere-else"])).toBeUndefined()
    expect(findProjectForDirectory([directoryKeyed], [undefined])).toBeUndefined()
  })
})

describe("createNewSessionWorkspaceState duplicate roots", () => {
  // Both signed groupings push EVERY workspace directory into `sandboxes`,
  // including the project root's — and MAIN_WORKTREE already stands for that
  // root. The hosted cloud picker therefore listed two identical "main" rows.
  test("does not list the project root twice when sandboxes include it", () => {
    expect(createNewSessionWorkspaceState({
      projectRoot: "/workspace",
      selectedWorktree: MAIN_WORKTREE,
      workspaceKind: "cloud",
      sandboxes: ["/workspace", "/workspace-2"],
      workspaces: {
        "/workspace": { kind: "cloud", workspace_name: "main" },
        "/workspace-2": { kind: "cloud", workspace_name: "feature" },
      },
    }).options).toEqual([MAIN_WORKTREE, "/workspace-2"])
  })
})
