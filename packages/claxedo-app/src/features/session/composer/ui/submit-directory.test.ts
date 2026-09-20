import { describe, expect, test } from "bun:test"
import type { CloudStartupState } from "./submit-create-session"
import { resolvePreparedSubmitDirectory, type SubmitToast } from "./submit-directory"

describe("resolvePreparedSubmitDirectory", () => {
  test("provisions a provisioner-placed workspace, bootstraps, prepares runtime, and publishes loading handoff", async () => {
    const createdProjects: string[] = []
    const bootstraps: string[] = []
    const preparedDirectories: string[] = []
    const handoffs: string[] = []

    const result = await resolveDirectory({
      hostKind: "provisioner",
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
        return { ok: true, startup: true, workspace: { kind: "provisioner", workspaceId: "ws_1", status: "ready" } }
      },
    })

    expect(result).toEqual({ directory: "ws_1" })
    expect(createdProjects).toEqual(["project-1"])
    expect(bootstraps).toEqual(["bootstrap"])
    expect(preparedDirectories).toEqual(["ws_1"])
    expect(handoffs).toEqual(["loading_models:Runtime ready. Loading models."])
  })

  test("a missing machine-placed workspace shows the attach-workspace toast and provisions nothing", async () => {
    const toasts: SubmitToast[] = []
    const createdProjects: string[] = []

    const result = await resolveDirectory({
      hostKind: "machine",
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

  test("prepares machine-placed workspaces without provisioning", async () => {
    const prepared: Array<{ workspaceId: string; baseUrl?: string }> = []
    const createdProjects: string[] = []

    const result = await resolveDirectory({
      hostKind: "machine",
      worktreeSelection: "workspace:machine_1",
      projectDirectory: "workspace:machine_1",
      runtimeWorkspaceRef: (directory) =>
        directory === "workspace:machine_1" ? { workspaceId: "machine_1", kind: "machine" } : undefined,
      workspaceForDirectory: (directory) =>
        directory === "workspace:machine_1" ? { workspaceId: "machine_1", kind: "machine" } : undefined,
      createCloudWorkspace: async (projectId) => {
        createdProjects.push(projectId)
        return { workspaceId: "ws_1" }
      },
      prepareMachineRuntime: async (input) => {
        prepared.push({ workspaceId: input.workspaceId, baseUrl: input.baseUrl })
        input.onLog?.({ step: "checking_health", message: "Checking runtime health", ts: 456 })
        return { ok: true, status: "ready" }
      },
    })

    expect(result).toEqual({ directory: "workspace:machine_1" })
    expect(createdProjects).toEqual([])
    expect(prepared).toEqual([{ workspaceId: "machine_1", baseUrl: "http://127.0.0.1:3001" }])
  })

  test("resolves machine-placed filesystem directories through the SDK workspace inventory", async () => {
    const prepared: string[] = []
    const result = await resolveDirectory({
      hostKind: "machine",
      draftId: "draft_1",
      projectDirectory: "/repo/on-a-machine",
      runtimeWorkspaceRef: () => undefined,
      workspaceForDirectory: (directory) =>
        directory === "/repo/on-a-machine" ? { workspaceId: "machine_filesystem", kind: "machine" } : undefined,
      prepareMachineRuntime: async (input) => {
        prepared.push(input.workspaceId)
        return { ok: true, status: "ready" }
      },
    })

    expect(result).toEqual({ directory: "/repo/on-a-machine" })
    expect(prepared).toEqual(["machine_filesystem"])
  })

  test("reuses cloud filesystem directories from the SDK workspace inventory instead of provisioning", async () => {
    const prepared: string[] = []
    const createdProjects: string[] = []
    const result = await resolveDirectory({
      hostKind: "provisioner",
      projectDirectory: "/repo/cloud-workspace",
      runtimeWorkspaceRef: () => undefined,
      workspaceForDirectory: (directory) =>
        directory === "/repo/cloud-workspace" ? { workspaceId: "ws_cloud_filesystem", kind: "provisioner" } : undefined,
      createCloudWorkspace: async (projectId) => {
        createdProjects.push(projectId)
        return { workspaceId: "ws_unexpected" }
      },
      prepareWorkspaceRuntime: async (input) => {
        prepared.push(input.directory ?? "")
        return {
          ok: true,
          startup: false,
          workspace: { kind: "provisioner", workspaceId: "ws_cloud_filesystem", status: "ready" },
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
      hostKind: "provisioner",
      worktreeSelection: "workspace:ws_1",
      runtimeWorkspaceRef: () => ({ workspaceId: "ws_1", kind: "provisioner" }),
      workspaceForDirectory: () => ({ workspaceId: "ws_1", kind: "provisioner" }),
      onCloudStartup: (state) => states.push(state),
      publishCloudHandoff: (status) => handoffs.push(status),
      prepareWorkspaceRuntime: async (input) => {
        input.onLog?.({ step: "error", message: "Runtime failed", ts: 789 })
        return { ok: false, startup: true, message: "Runtime failed", workspace: { kind: "provisioner", workspaceId: "ws_1", status: "failed" } }
      },
    })

    expect(result).toBeUndefined()
    expect(handoffs).toEqual([])
    // Submit-time cloud prepare uses overlay: false — failures publish to
    // rememberCloudStartup only, not the full-screen gate overlay.
    expect(states).toEqual([])
  })

  test("provisioner-placed workspace creation rejection shows exactly one toast and aborts", async () => {
    const toasts: SubmitToast[] = []

    const result = await resolveDirectory({
      hostKind: "provisioner",
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

  test("a provisioner-placed workspace resolving without a workspaceId shows the request-failed toast once", async () => {
    const toasts: SubmitToast[] = []

    const result = await resolveDirectory({
      hostKind: "provisioner",
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
      hostKind: "self",
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
      hostKind: "self",
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
      hostKind: "provisioner",
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
        directory === "ws_other" ? { workspaceId: "ws_other", kind: "provisioner" } : undefined,
      workspaceForDirectory: (directory) =>
        directory === "ws_other" ? { workspaceId: "ws_other", kind: "provisioner" } : undefined,
      createCloudWorkspace: async () => ({ workspaceId: "ws_selected" }),
      prepareWorkspaceRuntime: async (input) => {
        prepared.push(input.directory)
        return { ok: true, startup: true, workspace: { kind: "provisioner", workspaceId: input.directory, status: "ready" } }
      },
    })

    expect(result).toEqual({ directory: "ws_selected" })
    expect(prepared).toEqual(["ws_selected"])
  })

  test("create cloud sandbox selection provisions even when the project already has a provisioner-placed workspace", async () => {
    const createdProjects: string[] = []
    const existingWorkspaceId = "ws_existing"
    const result = await resolveDirectory({
      hostKind: "provisioner",
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
        directory === existingWorkspaceId ? { workspaceId: existingWorkspaceId, kind: "provisioner" } : undefined,
      workspaceForDirectory: (directory) =>
        directory === existingWorkspaceId ? { workspaceId: existingWorkspaceId, kind: "provisioner" } : undefined,
      createCloudWorkspace: async (projectId) => {
        createdProjects.push(projectId)
        return { workspaceId: "ws_new" }
      },
      prepareWorkspaceRuntime: async () => ({
        ok: true,
        startup: true,
        workspace: { kind: "provisioner", workspaceId: "ws_new", status: "ready" },
      }),
    })

    expect(result).toEqual({ directory: "ws_new" })
    expect(createdProjects).toEqual(["project-1"])
  })

  test("remaps a local association UUID directory to the project worktree before create", async () => {
    const associationId = "5f39af3e-75c4-4392-baaf-574acbbf9db9"
    const result = await resolveDirectory({
      hostKind: "self",
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
      hostKind: "self",
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
    hostKind: "self",
    projects: [],
    runtimeWorkspaceRef: () => undefined,
    workspaceForDirectory: () => undefined,
    isWorkspaceReady: () => false,
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
