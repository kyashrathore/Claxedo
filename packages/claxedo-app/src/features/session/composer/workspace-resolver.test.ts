import { describe, expect, test } from "bun:test"

import {
  composerUsesSignedTransport,
  existingRemoteWorkspaceDirectory,
  projectForDirectory,
  resolveWorkspaceSubmitPlan,
  sessionRefForSubmitTarget,
  signedWorkspaceHostKind,
  selectedNewSessionWorkspace,
  submitSessionDirectory,
  workspaceForDirectory,
  type ProjectCatalogItem,
  projectRepoUrl,
} from "./workspace-resolver"

describe("projectRepoUrl", () => {
  test("reads the repository source owned by project inventory", () => {
    expect(projectRepoUrl({
      id: "project-1",
      workspaces: {
        local: {
          kind: "local",
          git_remote: " https://github.com/kyashrathore/plugins.git ",
        },
      },
    })).toBe("https://github.com/kyashrathore/plugins.git")
  })

  test("does not synthesize a source when inventory has none", () => {
    expect(projectRepoUrl({ id: "project-1", workspaces: {} })).toBeUndefined()
  })
})

describe("selectedNewSessionWorkspace", () => {
  test("carries an explicitly selected cloud workspace into submit authority", () => {
    expect(selectedNewSessionWorkspace({
      newSession: true,
      kind: "provisioner",
      worktree: "ws_cloud",
    })).toEqual({ kind: "provisioner", workspaceId: "ws_cloud" })
  })

  test("marks new cloud provisioning as signed without inventing a workspace id", () => {
    expect(selectedNewSessionWorkspace({
      newSession: true,
      kind: "provisioner",
      worktree: "create",
    })).toEqual({ kind: "provisioner" })
  })

  test("does not classify local or existing-session input as remote", () => {
    expect(selectedNewSessionWorkspace({ newSession: true, kind: "self", worktree: "main" })).toBeUndefined()
    expect(selectedNewSessionWorkspace({ newSession: false, kind: "provisioner", worktree: "ws_cloud" })).toBeUndefined()
  })
})

const projects = [
  {
    id: "proj_1",
    worktree: "/repo/main",
    sandboxes: ["/repo/sandbox"],
    workspaces: {
      ws_cloud_main: {
        workspaceId: "ws_cloud_main",
        kind: "cloud",
        directory: "/repo/cloud-main",
        workspace_name: "main",
      },
      ws_user_hosted: {
        workspaceId: "ws_user_hosted",
        kind: "user-hosted",
        directory: "/tmp/hosted",
      },
    },
  },
] satisfies ProjectCatalogItem[]

describe("signedWorkspaceHostKind", () => {
  test("reads the sdk workspace's host kind without translating it as a wire word", () => {
    expect(signedWorkspaceHostKind({
      directory: "/repo/elsewhere",
      projects,
      sdkWorkspace: { workspaceId: "ws_m", kind: "machine", directory: "/repo/elsewhere" },
    })).toBe("machine")
    expect(signedWorkspaceHostKind({
      directory: "/repo/elsewhere",
      projects,
      sdkWorkspace: { workspaceId: "ws_p", kind: "provisioner", directory: "/repo/elsewhere" },
    })).toBe("provisioner")
  })

  test("narrows a catalog row's wire word, which the sdk's answer outranks", () => {
    expect(signedWorkspaceHostKind({ directory: "/tmp/hosted", projects })).toBe("machine")
    expect(signedWorkspaceHostKind({ directory: "/repo/cloud-main", projects })).toBe("provisioner")
    expect(signedWorkspaceHostKind({
      directory: "/tmp/hosted",
      projects,
      sdkWorkspace: { workspaceId: "ws_p", kind: "provisioner" },
    })).toBe("provisioner")
  })
})

describe("composerUsesSignedTransport", () => {
  const loopback = "http://127.0.0.1:3001"

  test("an sdk workspace on a machine takes signed transport on a loopback server", () => {
    expect(composerUsesSignedTransport({
      directory: "/repo/elsewhere",
      projects,
      sdkWorkspace: { workspaceId: "ws_m", kind: "machine", directory: "/repo/elsewhere" },
      principalHasSignedAccess: false,
      serverUrl: loopback,
    })).toBe(true)
  })

  test("an sdk workspace on the provisioner takes signed transport on a loopback server", () => {
    expect(composerUsesSignedTransport({
      directory: "/repo/elsewhere",
      projects,
      sdkWorkspace: { workspaceId: "ws_p", kind: "provisioner", directory: "/repo/elsewhere" },
      principalHasSignedAccess: false,
      serverUrl: loopback,
    })).toBe(true)
  })

  test("a catalog row the sdk has not matched still takes signed transport", () => {
    expect(composerUsesSignedTransport({
      directory: "/tmp/hosted",
      projects,
      principalHasSignedAccess: false,
      serverUrl: loopback,
    })).toBe(true)
  })

  test("a directory no source places remotely stays on loopback", () => {
    expect(composerUsesSignedTransport({
      directory: "/repo/main",
      projects,
      principalHasSignedAccess: false,
      serverUrl: loopback,
    })).toBe(false)
  })
})

describe("composer workspace resolver", () => {
  test("matches projects and workspaces by worktree, sandbox, workspace id, and normalized directory", () => {
    expect(projectForDirectory(projects, "/repo/main")?.id).toBe("proj_1")
    expect(projectForDirectory(projects, "/repo/sandbox")?.id).toBe("proj_1")
    expect(projectForDirectory(projects, "ws_cloud_main")?.id).toBe("proj_1")
    expect(workspaceForDirectory(projects, "/private/tmp/hosted")?.kind).toBe("user-hosted")
  })

  test("uses signed workspace directory for submit directory compatibility", () => {
    expect(submitSessionDirectory({
      directory: "ws_cloud_main",
      projects,
    })).toBe("ws_cloud_main")
    expect(submitSessionDirectory({
      directory: "/repo/cloud-main",
      projects,
    })).toBe("/repo/cloud-main")
    expect(submitSessionDirectory({
      directory: "/repo/main",
      projects,
      sdkWorkspace: { workspaceId: "ws_sdk", kind: "provisioner", directory: "/repo/sdk" },
    })).toBe("/repo/sdk")
  })

  test("existing sessions resolve to project, fallback, then default directory", () => {
    expect(resolveWorkspaceSubmitPlan({
      isNewSession: false,
      projectDirectory: "/repo/main",
      defaultDirectory: "/default",
      worktreeSelection: "main",
      hostKind: "self",
      projects,
    })).toEqual({ status: "ready", directory: "/repo/main" })
    expect(resolveWorkspaceSubmitPlan({
      isNewSession: false,
      fallbackDirectory: "/fallback",
      defaultDirectory: "/default",
      worktreeSelection: "main",
      hostKind: "self",
      projects,
    })).toEqual({ status: "ready", directory: "/fallback" })
    expect(resolveWorkspaceSubmitPlan({
      isNewSession: false,
      defaultDirectory: "/default",
      worktreeSelection: "main",
      hostKind: "self",
      projects,
    })).toEqual({ status: "ready", directory: "/default" })
  })

  test("local create and explicit worktree selections are planned without side effects", () => {
    expect(resolveWorkspaceSubmitPlan({
      isNewSession: true,
      projectDirectory: "/repo/main",
      defaultDirectory: "/default",
      worktreeSelection: "create",
      hostKind: "self",
      projects,
    })).toEqual({ status: "create-local-worktree", baseDirectory: "/repo/main" })
    expect(resolveWorkspaceSubmitPlan({
      isNewSession: true,
      projectDirectory: "/repo/main",
      defaultDirectory: "/default",
      worktreeSelection: "/repo/feature",
      hostKind: "self",
      projects,
    })).toEqual({ status: "ready", directory: "/repo/feature" })
  })

  test("cloud main reuses an existing cloud main workspace", () => {
    expect(resolveWorkspaceSubmitPlan({
      isNewSession: true,
      projectDirectory: "/repo/main",
      defaultDirectory: "/default",
      worktreeSelection: "main",
      hostKind: "provisioner",
      projects,
    })).toEqual({ status: "prepare-remote-workspace", directory: "ws_cloud_main" })
  })

  test("cloud create selection provisions a new workspace even when project main already exists", () => {
    expect(resolveWorkspaceSubmitPlan({
      isNewSession: true,
      projectDirectory: "/repo/main",
      defaultDirectory: "/default",
      worktreeSelection: "create",
      hostKind: "provisioner",
      projects,
    })).toEqual({ status: "provision-cloud-workspace", projectId: "proj_1" })
  })

  test("cloud workspace id routes keep the routed workspace instead of project main", () => {
    expect(resolveWorkspaceSubmitPlan({
      isNewSession: true,
      projectDirectory: "ws_live",
      defaultDirectory: "/default",
      worktreeSelection: "main",
      hostKind: "provisioner",
      projects,
      runtimeWorkspaceRef: (directory) =>
        directory === "ws_live" ? { workspaceId: "ws_live", kind: "provisioner" } : undefined,
    })).toEqual({ status: "prepare-remote-workspace", directory: "ws_live" })
  })

  test("cloud missing an existing workspace plans provisioning from project id", () => {
    expect(resolveWorkspaceSubmitPlan({
      isNewSession: true,
      projectDirectory: "/repo/main",
      defaultDirectory: "/default",
      worktreeSelection: "main",
      hostKind: "provisioner",
      projects: [{ id: "proj_1", worktree: "/repo/main", workspaces: {} }],
    })).toEqual({ status: "provision-cloud-workspace", projectId: "proj_1" })
  })

  test("user-hosted workspaces never plan cloud provisioning", () => {
    expect(resolveWorkspaceSubmitPlan({
      isNewSession: true,
      projectDirectory: "/repo/main",
      defaultDirectory: "/default",
      worktreeSelection: "/repo/not-registered",
      hostKind: "machine",
      projects,
    })).toEqual({ status: "missing-workspace" })
  })

  test("runtime workspace refs are treated as existing remote workspaces", () => {
    expect(existingRemoteWorkspaceDirectory({
      worktreeSelection: "main",
      directory: "workspace:ws_live",
      projects: [],
      runtimeWorkspaceRef: (directory) =>
        directory === "workspace:ws_live" ? { workspaceId: "ws_live", kind: "machine" } : undefined,
    })).toBe("workspace:ws_live")
  })

  test("session refs prefer runtime workspace backing, then inventory backing, then local cwd", () => {
    expect(sessionRefForSubmitTarget({
      sessionId: "ses_runtime",
      directory: "/repo/cloud-main",
      projects,
      runtimeWorkspaceRef: { workspaceId: "ws_live", kind: "provisioner" },
    })?.toolSandbox).toEqual({ kind: "workspace", workspaceId: "ws_live", hosting: "provisioner" })

    expect(sessionRefForSubmitTarget({
      sessionId: "ses_inventory",
      directory: "/repo/cloud-main",
      projects,
    })?.toolSandbox).toEqual({ kind: "workspace", workspaceId: "ws_cloud_main", hosting: "provisioner" })

    expect(sessionRefForSubmitTarget({
      sessionId: "ses_local",
      directory: "/repo/main",
      projects,
    })?.toolSandbox).toEqual({ kind: "local", cwd: "/repo/main" })

    expect(sessionRefForSubmitTarget({
      sessionId: "ses_harness",
      directory: "/repo/main",
      projects,
      harness: { id: "codex-acp" },
    })?.harness).toEqual({ id: "codex-acp" })
  })
})
