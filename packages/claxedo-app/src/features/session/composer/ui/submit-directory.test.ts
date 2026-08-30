import { describe, expect, test } from "bun:test"
import type { CloudStartupState } from "./submit-create-session"
import {
  resolvePreparedSubmitDirectory,
  type SubmitDirectoryProvisionInput,
  type SubmitToast,
} from "./submit-directory"

describe("resolvePreparedSubmitDirectory", () => {
  test("provisions a cloud workspace, bootstraps, prepares runtime, and publishes loading handoff", async () => {
    const createdProjects: string[] = []
    const bootstraps: string[] = []
    const preparedDirectories: string[] = []
    const handoffs: string[] = []

    const result = await resolveDirectory({
      workspaceKind: "cloud",
      projectDirectory: "/repo/main",
      projects: [{ id: "project-1", worktree: "/repo/main" }],
      createCloudWorkspace: async (projectId) => {
        createdProjects.push(projectId)
        return { workspaceId: "ws_1" }
      },
      bootstrap: () => {
        bootstraps.push("bootstrap")
      },
      publishCloudHandoff: (status, message) => handoffs.push(`${status}:${message}`),
      prepareWorkspaceRuntime: async (input) => {
        preparedDirectories.push(input.directory)
        input.onLog?.({ step: "ready", ts: 123 })
        return { ok: true, startup: true, workspace: { kind: "cloud", workspaceId: "ws_1", status: "ready" } }
      },
    })

    expect(result).toEqual({ directory: "ws_1" })
    expect(createdProjects).toEqual(["project-1"])
    expect(bootstraps).toEqual(["bootstrap"])
    expect(preparedDirectories).toEqual(["ws_1"])
    expect(handoffs).toEqual(["loading_models:Runtime ready. Loading models."])
  })

  test("missing user-hosted workspace shows attach-workspace toast and does not provision cloud", async () => {
    const toasts: SubmitToast[] = []
    const createdProjects: string[] = []

    const result = await resolveDirectory({
      workspaceKind: "user-hosted",
      projectDirectory: "/repo/main",
      projects: [{ id: "project-1", worktree: "/repo/main" }],
      showToast: (toast) => toasts.push(toast),
      createCloudWorkspace: async (projectId) => {
        createdProjects.push(projectId)
        return { workspaceId: "ws_1" }
      },
    })

    expect(result).toBeUndefined()
    expect(createdProjects).toEqual([])
    expect(toasts).toEqual([
      {
        title: "Failed to create cloud workspace",
        description: "Attach a workspace before sending a prompt.",
      },
    ])
  })

  test("prepares user-hosted workspaces without provisioning cloud", async () => {
    const prepared: Array<{ workspaceId: string; baseUrl?: string }> = []
    const createdProjects: string[] = []

    const result = await resolveDirectory({
      workspaceKind: "user-hosted",
      worktreeSelection: "workspace:uh_1",
      projectDirectory: "workspace:uh_1",
      runtimeWorkspaceRef: (directory) =>
        directory === "workspace:uh_1" ? { workspaceId: "uh_1", kind: "user-hosted" } : undefined,
      workspaceForDirectory: (directory) =>
        directory === "workspace:uh_1" ? { workspaceId: "uh_1", kind: "user-hosted" } : undefined,
      createCloudWorkspace: async (projectId) => {
        createdProjects.push(projectId)
        return { workspaceId: "ws_1" }
      },
      prepareUserHostedRuntime: async (input) => {
        prepared.push({ workspaceId: input.workspaceId, baseUrl: input.baseUrl })
        input.onLog?.({ step: "checking_health", message: "Checking runtime health", ts: 456 })
        return { ok: true, status: "ready" }
      },
    })

    expect(result).toEqual({ directory: "workspace:uh_1" })
    expect(createdProjects).toEqual([])
    expect(prepared).toEqual([{ workspaceId: "uh_1", baseUrl: "http://127.0.0.1:3001" }])
  })

  test("resolves user-hosted filesystem directories through the SDK workspace inventory", async () => {
    const prepared: string[] = []
    const result = await resolveDirectory({
      workspaceKind: "user-hosted",
      draftId: "draft_1",
      projectDirectory: "/repo/user-hosted",
      runtimeWorkspaceRef: () => undefined,
      workspaceForDirectory: (directory) => ({
        workspaceId: "uh_filesystem",
        kind: directory === "/repo/user-hosted" ? "user-hosted" : undefined,
      }),
      prepareUserHostedRuntime: async (input) => {
        prepared.push(input.workspaceId)
        return { ok: true, status: "ready" }
      },
    })

    expect(result).toEqual({ directory: "/repo/user-hosted" })
    expect(prepared).toEqual(["uh_filesystem"])
  })

  test("reuses cloud filesystem directories from the SDK workspace inventory instead of provisioning", async () => {
    const prepared: string[] = []
    const createdProjects: string[] = []
    const result = await resolveDirectory({
      workspaceKind: "cloud",
      projectDirectory: "/repo/cloud-workspace",
      runtimeWorkspaceRef: () => undefined,
      workspaceForDirectory: (directory) => ({
        workspaceId: "ws_cloud_filesystem",
        kind: directory === "/repo/cloud-workspace" ? "cloud" : undefined,
      }),
      createCloudWorkspace: async (projectId) => {
        createdProjects.push(projectId)
        return { workspaceId: "ws_unexpected" }
      },
      prepareWorkspaceRuntime: async (input) => {
        prepared.push(input.directory ?? "")
        return {
          ok: true,
          startup: false,
          workspace: { kind: "cloud", workspaceId: "ws_cloud_filesystem", status: "ready" },
        }
      },
    })

    expect(result).toEqual({ directory: "/repo/cloud-workspace" })
    expect(prepared).toEqual(["/repo/cloud-workspace"])
    expect(createdProjects).toEqual([])
  })

  test("prepare failure returns undefined and never publishes loading-models handoff", async () => {
    const handoffs: string[] = []
    const states: Array<CloudStartupState | undefined> = []

    const result = await resolveDirectory({
      workspaceKind: "cloud",
      worktreeSelection: "workspace:ws_1",
      runtimeWorkspaceRef: () => ({ workspaceId: "ws_1", kind: "cloud" }),
      workspaceForDirectory: () => ({ workspaceId: "ws_1", kind: "cloud" }),
      onCloudStartup: (state) => states.push(state),
      publishCloudHandoff: (status) => handoffs.push(status),
      prepareWorkspaceRuntime: async (input) => {
        input.onLog?.({ step: "error", message: "Runtime failed", ts: 789 })
        return { ok: false, startup: true, message: "Runtime failed", workspace: { kind: "cloud", workspaceId: "ws_1", status: "failed" } }
      },
    })

    expect(result).toBeUndefined()
    expect(handoffs).toEqual([])
    // Submit-time cloud prepare uses overlay: false — failures publish to
    // rememberCloudStartup only, not the full-screen gate overlay.
    expect(states).toEqual([])
  })

  test("cloud workspace creation rejection shows exactly one toast and aborts", async () => {
    const toasts: SubmitToast[] = []

    const result = await resolveDirectory({
      workspaceKind: "cloud",
      projectDirectory: "/repo/main",
      projects: [{ id: "project-1", worktree: "/repo/main" }],
      showToast: (toast) => toasts.push(toast),
      createCloudWorkspace: async () => {
        throw new Error("boom")
      },
    })

    expect(result).toBeUndefined()
    expect(toasts).toEqual([
      {
        title: "Failed to create cloud workspace",
        description: "boom",
      },
    ])
  })

  test("cloud workspace resolving without a workspaceId shows the request-failed toast once", async () => {
    const toasts: SubmitToast[] = []

    const result = await resolveDirectory({
      workspaceKind: "cloud",
      projectDirectory: "/repo/main",
      projects: [{ id: "project-1", worktree: "/repo/main" }],
      showToast: (toast) => toasts.push(toast),
      createCloudWorkspace: async () => ({}),
    })

    expect(result).toBeUndefined()
    expect(toasts).toEqual([
      {
        title: "Failed to create cloud workspace",
        description: "Request failed",
      },
    ])
  })

  test("creates local worktrees from the project root and marks the result pending", async () => {
    const createdFrom: string[] = []
    const pending: string[] = []
    const lifecycle: string[] = []

    const result = await resolveDirectory({
      workspaceKind: "local",
      worktreeSelection: "create",
      projectDirectory: "/repo/worktree-a",
      projects: [{ id: "project-1", worktree: "/repo/main", sandboxes: ["/repo/worktree-a"] }],
      createLocalWorktree: async (directory) => {
        createdFrom.push(directory)
        return { directory: "/repo/feature" }
      },
      markLocalWorktreePending: (directory) => {
        pending.push(directory)
        lifecycle.push("pending")
      },
      bootstrap: async () => {
        lifecycle.push("bootstrap:start")
        await Promise.resolve()
        lifecycle.push("bootstrap:complete")
      },
    })

    expect(result).toEqual({ directory: "/repo/feature" })
    expect(createdFrom).toEqual(["/repo/main"])
    expect(pending).toEqual(["/repo/feature"])
    expect(lifecycle).toEqual(["pending", "bootstrap:start", "bootstrap:complete"])
  })

  test("keeps the created worktree handoff when its inventory refresh fails", async () => {
    const result = await resolveDirectory({
      workspaceKind: "local",
      worktreeSelection: "create",
      projectDirectory: "/repo/main",
      projects: [{ id: "project-1", worktree: "/repo/main" }],
      createLocalWorktree: async () => ({ directory: "/repo/feature" }),
      bootstrap: async () => {
        throw new Error("inventory temporarily unavailable")
      },
    })

    expect(result).toEqual({ directory: "/repo/feature" })
  })

  test("does not steal a remote directory from an unrelated project in the catalog", async () => {
    const prepared: string[] = []
    const result = await resolveDirectory({
      workspaceKind: "cloud",
      projectDirectory: "/repo/selected",
      defaultDirectory: "/repo/selected",
      projects: [
        { id: "selected", worktree: "/repo/selected" },
        {
          id: "other",
          worktree: "/repo/other",
          workspaces: {
            ws_other: { directory: "ws_other", kind: "cloud" },
          },
        },
      ],
      runtimeWorkspaceRef: (directory) =>
        directory === "ws_other" ? { workspaceId: "ws_other", kind: "cloud" } : undefined,
      workspaceForDirectory: (directory) =>
        directory === "ws_other" ? { workspaceId: "ws_other", kind: "cloud" } : undefined,
      createCloudWorkspace: async () => ({ workspaceId: "ws_selected" }),
      prepareWorkspaceRuntime: async (input) => {
        prepared.push(input.directory)
        return { ok: true, startup: true, workspace: { kind: "cloud", workspaceId: input.directory, status: "ready" } }
      },
    })

    expect(result).toEqual({ directory: "ws_selected" })
    expect(prepared).toEqual(["ws_selected"])
  })

  test("create cloud sandbox selection provisions even when the project already has a cloud workspace", async () => {
    const createdProjects: string[] = []
    const existingWorkspaceId = "ws_existing"
    const result = await resolveDirectory({
      workspaceKind: "cloud",
      worktreeSelection: "create",
      projectDirectory: "/repo/main",
      defaultDirectory: existingWorkspaceId,
      projects: [{
        id: "project-1",
        worktree: "/repo/main",
        sandboxes: [existingWorkspaceId],
        workspaces: {
          [existingWorkspaceId]: { kind: "cloud", workspaceId: existingWorkspaceId, workspace_name: "main" },
        },
      }],
      runtimeWorkspaceRef: (directory) =>
        directory === existingWorkspaceId ? { workspaceId: existingWorkspaceId, kind: "cloud" } : undefined,
      workspaceForDirectory: (directory) =>
        directory === existingWorkspaceId ? { workspaceId: existingWorkspaceId, kind: "cloud" } : undefined,
      createCloudWorkspace: async (projectId) => {
        createdProjects.push(projectId)
        return { workspaceId: "ws_new" }
      },
      prepareWorkspaceRuntime: async () => ({
        ok: true,
        startup: true,
        workspace: { kind: "cloud", workspaceId: "ws_new", status: "ready" },
      }),
    })

    expect(result).toEqual({ directory: "ws_new" })
    expect(createdProjects).toEqual(["project-1"])
  })

  test("remaps a local association UUID directory to the project worktree before create", async () => {
    const associationId = "5f39af3e-75c4-4392-baaf-574acbbf9db9"
    const result = await resolveDirectory({
      workspaceKind: "local",
      defaultDirectory: associationId,
      projects: [{
        id: "project-1",
        worktree: "/Users/me/repo",
        workspaces: {
          "/Users/me/repo": {
            id: associationId,
            directory: "/Users/me/repo",
            kind: "local",
          },
        },
      }],
    })
    expect(result).toEqual({ directory: "/Users/me/repo" })
  })

  test("blocks local create when an association UUID cannot be remapped to a path", async () => {
    const toasts: SubmitToast[] = []
    const associationId = "5f39af3e-75c4-4392-baaf-574acbbf9db9"
    const result = await resolveDirectory({
      workspaceKind: "local",
      defaultDirectory: associationId,
      projects: [],
      showToast: (toast) => toasts.push(toast),
    })
    expect(result).toBeUndefined()
    expect(toasts).toEqual([{
      title: "prompt.toast.sessionCreateFailed.title",
      description: "Attach a workspace before sending a prompt.",
    }])
  })
})

type ResolveDirectoryInput = Parameters<typeof resolvePreparedSubmitDirectory>[0]

function resolveDirectory(overrides: Partial<ResolveDirectoryInput>) {
  return resolvePreparedSubmitDirectory({
    isNewSession: true,
    draftId: undefined,
    projectDirectory: undefined,
    fallbackDirectory: undefined,
    defaultDirectory: "/repo/main",
    worktreeSelection: "main",
    workspaceKind: "local",
    projects: [],
    runtimeWorkspaceRef: () => undefined,
    workspaceForDirectory: () => undefined,
    baseUrl: "http://127.0.0.1:3001",
    request: fetch,
    events: undefined,
    onCloudStartup: undefined,
    rememberCloudStartup: () => {},
    publishCloudHandoff: () => {},
    createCloudWorkspace: async () => ({ workspaceId: "ws_1" }),
    createLocalWorktree: async (directory) => ({ directory }),
    markLocalWorktreePending: () => {},
    bootstrap: () => undefined,
    showToast: () => {},
    errorMessage: (err) => err instanceof Error ? err.message : String(err),
    text: {
      worktreeCreateFailedTitle: "Failed to create worktree",
      missingWorkspaceTitle: "prompt.toast.sessionCreateFailed.title",
      selectProjectForWorktree: "Select a project before creating a local worktree.",
      requestFailed: "Request failed",
      cloudWorkspaceCreateFailedTitle: "Failed to create cloud workspace",
      attachWorkspaceBeforePrompt: "Attach a workspace before sending a prompt.",
      attachProjectBeforeCloudWorkspace: "Attach a project before creating a cloud workspace.",
    },
    ...overrides,
  })
}
