import { describe, expect, test } from "bun:test"
import { CREATE_WORKTREE, createNewSessionWorkspaceState, MAIN_WORKTREE } from "./session-new-workspace-options"

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
