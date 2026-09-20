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
  test("keeps the selected checkout when inventory uses workspace IDs as keys", () => {
    const state = createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: "/repo/feature",
      hostKind: "self",
      sandboxes: ["ws_feature", "/repo/feature"],
      workspaces: {
        ws_main: { id: "ws_main", directory: "/repo/main", kind: "local" },
        ws_feature: { id: "ws_feature", directory: "/repo/feature", kind: "local" },
        ws_missing: { id: "ws_missing", directory: "/repo/missing", kind: "local", available: false },
      },
    })
    expect(state.options).toEqual([MAIN_WORKTREE, "/repo/feature"])
    expect(state.currentWorktree).toBe("/repo/feature")
    expect(state.creatingWorkspace).toBe(false)
  })

  test("filters this machine's workspace choices from the provisioner-placed ones", () => {
    const sandboxes = ["/repo/local-feature", "workspace:cloud-main", "workspace:cloud-feature"]

    expect(createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: MAIN_WORKTREE,
      hostKind: "self",
      sandboxes,
      workspaces,
    }).options).toEqual([MAIN_WORKTREE, "/repo/local-feature"])

    expect(createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: "workspace:cloud-main",
      hostKind: "provisioner",
      sandboxes,
      workspaces,
    }).options).toEqual(["workspace:cloud-main", "workspace:cloud-feature"])
  })

  test("keeps create-new mutually exclusive from selecting an existing workspace", () => {
    const state = createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: CREATE_WORKTREE,
      hostKind: "self",
      sandboxes: ["/repo/local-feature"],
      workspaces,
    })

    expect(state.creatingWorkspace).toBe(true)
    expect(state.currentWorktree).toBe(MAIN_WORKTREE)
  })

  test("the provisioner defaults to create-new when no provisioner-placed workspace exists", () => {
    const state = createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: MAIN_WORKTREE,
      hostKind: "provisioner",
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
      hostKind: "provisioner",
    }).options).toEqual([MAIN_WORKTREE])

    expect(createNewSessionWorkspaceState({
      projectRoot: "workspace:ws_prefixed",
      selectedWorktree: MAIN_WORKTREE,
      hostKind: "provisioner",
    }).options).toEqual([MAIN_WORKTREE])

    expect(createNewSessionWorkspaceState({
      projectRoot: "workspace:ws_prefixed",
      selectedWorktree: MAIN_WORKTREE,
      hostKind: "self",
    }).options).toEqual([])
  })

  // Regression for the accidental-VM bug: a self-hosted (user-hosted) workspace
  // is its OWN kind and must never be collapsed into "cloud" — collapsing is what
  // dropped it into the cloud-provision create path.
  test("machine-placed workspaces are a distinct placement, never collapsed into the provisioner's", () => {
    const machineWorkspaces = {
      "/repo/main": { kind: "local" as const },
      "workspace:self-hosted": { kind: "user-hosted" as const, workspace_name: "my-machine" },
    }
    const sandboxes = ["workspace:self-hosted"]

    // It appears ONLY under the user-hosted kind...
    expect(createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: "workspace:self-hosted",
      hostKind: "machine",
      sandboxes,
      workspaces: machineWorkspaces,
    }).options).toEqual(["workspace:self-hosted"])

    // ...and is NOT offered as a cloud choice.
    expect(createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: MAIN_WORKTREE,
      hostKind: "provisioner",
      sandboxes,
      workspaces: machineWorkspaces,
    }).options).toEqual([])
  })

  // The fail-closed property: an empty user-hosted option set must NOT auto-flip
  // into create mode (that path only exists for "cloud"). No silent provisioning.
  test("a machine placement with no options never enters create-new mode", () => {
    const state = createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: MAIN_WORKTREE,
      hostKind: "machine",
      sandboxes: [],
      workspaces: { "/repo/main": { kind: "local" } },
    })

    expect(state.creatingWorkspace).toBe(false)
  })

  test("excludes unavailable workspace choices", () => {
    expect(createNewSessionWorkspaceState({
      projectRoot: "/repo/main",
      selectedWorktree: "workspace:cloud-main",
      hostKind: "provisioner",
      sandboxes: ["workspace:cloud-main", "workspace:cloud-feature"],
      workspaces: {
        ...workspaces,
        "workspace:cloud-main": { kind: "cloud", workspace_name: "main", available: false },
      },
    }).options).toEqual(["workspace:cloud-feature"])
  })
})

describe("newSessionEnvironmentOptions", () => {
  test("a server with no filesystem offers cloud only", () => {
    expect(newSessionEnvironmentOptions({ localExecution: false, signed: true })).toEqual(["provisioner"])
    expect(newSessionEnvironmentOptions({ localExecution: false, signed: false })).toEqual(["provisioner"])
  })

  test("a server with its own filesystem offers local, signed in or not", () => {
    expect(newSessionEnvironmentOptions({ localExecution: true, signed: true })).toEqual(["self", "provisioner"])
    expect(newSessionEnvironmentOptions({ localExecution: true, signed: false })).toEqual(["self", "provisioner"])
  })

  test("a server that says nothing about its filesystem falls back to the product its mode has always been", () => {
    expect(newSessionEnvironmentOptions({ localExecution: undefined, signed: false })).toEqual(["self", "provisioner"])
    expect(newSessionEnvironmentOptions({ localExecution: undefined, signed: true })).toEqual(["provisioner"])
  })

  test("cloud disappears where sandbox creation is off", () => {
    expect(newSessionEnvironmentOptions({ localExecution: true, signed: false, sandboxEnabled: false })).toEqual(["self"])
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
    const project = { ...idKeyed, worktree: "/project-root", sandboxes: ["/project-sandbox"] }
    expect(findProjectForDirectory([project], ["/project-root"])).toBe(project)
    expect(findProjectForDirectory([project], ["/project-sandbox"])).toBe(project)
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
      hostKind: "provisioner",
      sandboxes: ["/workspace", "/workspace-2"],
      workspaces: {
        "/workspace": { kind: "cloud", workspace_name: "main" },
        "/workspace-2": { kind: "cloud", workspace_name: "feature" },
      },
    }).options).toEqual([MAIN_WORKTREE, "/workspace-2"])
  })
})
