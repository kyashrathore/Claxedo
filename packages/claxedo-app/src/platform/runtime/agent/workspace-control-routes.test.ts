import { describe, expect, test } from "bun:test"
import {
  controlSessionListUrl,
  controlSessionNavigationListUrl,
  sessionNavigationListUrl,
  controlSessionUrl,
  controlWorkspaceUrl,
  experimentalSandboxPath,
  workspaceCreateUrl,
  workspaceCheckpointRestoreUrl,
  workspaceCheckpointsUrl,
  workspaceDefaultSandboxDriverUrl,
  workspaceSandboxDriverAuthUrl,
  workspaceSandboxDriversUrl,
  workspaceLifecycleUrl,
  workspaceResolveUrl,
} from "./workspace-control-routes"

describe("workspace control routes", () => {
  test("builds workspace sandbox driver, create, resolve, and delete URLs", () => {
    expect(workspaceSandboxDriversUrl({ baseUrl: "https://control.example.test/" }))
      .toBe("https://control.example.test/api/workspace/drivers")
    expect(workspaceSandboxDriverAuthUrl({
      baseUrl: "https://control.example.test/",
      driverId: "daytona/custom",
    })).toBe("https://control.example.test/api/workspace/drivers/daytona%2Fcustom/auth")
    expect(workspaceDefaultSandboxDriverUrl({ baseUrl: "https://control.example.test/" }))
      .toBe("https://control.example.test/api/workspace/drivers/default")
    expect(workspaceCreateUrl({ baseUrl: "https://control.example.test/" }))
      .toBe("https://control.example.test/api/workspace/create")
    expect(workspaceResolveUrl({
      baseUrl: "https://control.example.test/",
      workspaceId: "ws_123",
    })).toBe("https://control.example.test/api/workspace/resolve?workspaceId=ws_123")
    expect(workspaceResolveUrl({
      baseUrl: "https://control.example.test/",
      scope: "workspace:ws_123",
      create: true,
    })).toBe("https://control.example.test/api/workspace/resolve?workspaceId=ws_123&create=true")
    expect(workspaceResolveUrl({
      baseUrl: "http://127.0.0.1:4096/",
      scope: "/tmp/local workspace",
      create: true,
    })).toBe("http://127.0.0.1:4096/api/claxedo/workspace/resolve?directory=%2Ftmp%2Flocal+workspace&create=true")
    expect(controlWorkspaceUrl({
      baseUrl: "https://control.example.test/",
      workspaceId: "daytona/custom",
    })).toBe("https://control.example.test/api/workspace/daytona%2Fcustom")
  })

  test("builds control session routes", () => {
    expect(controlSessionListUrl({
      baseUrl: "https://control.example.test/",
      workspaceId: "ws_1",
      directory: "/repo",
    }).toString()).toBe("https://control.example.test/api/control/sessions?workspaceId=ws_1&directory=%2Frepo")
    expect(controlSessionUrl({
      baseUrl: "https://control.example.test/",
      sessionID: "session/with slash",
      suffix: "/gateway",
      workspaceId: "ws_1",
    }).toString()).toBe("https://control.example.test/api/control/sessions/session%2Fwith%20slash/gateway?workspaceId=ws_1")
    expect(controlSessionNavigationListUrl({
      baseUrl: "https://control.example.test/",
      scope: "global",
      projectId: "proj_1",
      workspaceId: "ws_1",
      directory: "/repo",
      groupBy: "workspace",
      archived: "archived",
      status: ["running", "idle"],
      environment: ["prod"],
      git: ["dirty", "clean"],
      search: "hello world",
      limit: 50,
      cursor: "cursor:1",
    }).toString()).toBe("https://control.example.test/api/control/session-list?scope=global&limit=50&projectId=proj_1&workspaceId=ws_1&directory=%2Frepo&groupBy=workspace&archived=archived&status=running%2Cidle&environment=prod&git=dirty%2Cclean&search=hello+world&cursor=cursor%3A1")
    expect(sessionNavigationListUrl({
      baseUrl: "http://127.0.0.1:3001/",
      scope: "workspace",
      directory: "/repo",
      limit: 20,
    }).toString()).toBe("http://127.0.0.1:3001/api/claxedo/session-list?scope=workspace&limit=20&directory=%2Frepo")
    expect(sessionNavigationListUrl({
      baseUrl: "https://control.example.test/",
      scope: "workspace",
      directory: "/repo",
      limit: 20,
    }).toString()).toBe("https://control.example.test/api/control/session-list?scope=workspace&limit=20&directory=%2Frepo")
  })

  test("builds cloud workspace lifecycle routes with encoded identities", () => {
    expect(workspaceCheckpointsUrl({
      baseUrl: "https://control.example.test/",
      workspaceId: "ws/custom",
    })).toBe("https://control.example.test/api/workspace/ws%2Fcustom/checkpoints")
    expect(workspaceCheckpointRestoreUrl({
      baseUrl: "https://control.example.test/",
      workspaceId: "ws/custom",
      checkpointId: "cp/custom",
    })).toBe("https://control.example.test/api/workspace/ws%2Fcustom/checkpoints/cp%2Fcustom/restore")
    expect(workspaceLifecycleUrl({
      baseUrl: "https://control.example.test/",
      workspaceId: "ws/custom",
      operation: "destroy",
    })).toBe("https://control.example.test/api/workspace/ws%2Fcustom/lifecycle/destroy")
  })

  test("builds experimental sandbox path", () => {
    expect(experimentalSandboxPath("workspace:ws_cloud"))
      .toBe("/api/experimental/sandbox?directory=workspace%3Aws_cloud")
  })

  test("workspace create surfaces do not import RuntimeGateway for stable route helpers", async () => {
    // DialogCreateCloudWorkspace (the dead New-workspace Local/Cloud dialog) was
    // deleted — see docs/e2e-decisions.md #16. project-actions.tsx remains the
    // live surface this guard protects.
    expect(await Bun.file(new URL("../../../features/workspaces/actions/project-actions.tsx", import.meta.url)).text())
      .not.toContain("RuntimeGateway")
  })
})
