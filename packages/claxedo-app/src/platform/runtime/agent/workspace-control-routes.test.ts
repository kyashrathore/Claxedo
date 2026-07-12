import { describe, expect, test } from "bun:test"
import {
  controlSessionListUrl,
  controlSessionNavigationListUrl,
  controlSessionUrl,
  controlWorkspaceUrl,
  experimentalSandboxPath,
  workspaceCreateUrl,
  workspaceDefaultProviderUrl,
  workspaceProviderAuthUrl,
  workspaceProvidersUrl,
  workspaceResolveUrl,
} from "./workspace-control-routes"

describe("workspace control routes", () => {
  test("builds workspace provider, create, resolve, and delete URLs", () => {
    expect(workspaceProvidersUrl({ baseUrl: "https://control.example.test/" }))
      .toBe("https://control.example.test/api/workspace/providers")
    expect(workspaceProviderAuthUrl({
      baseUrl: "https://control.example.test/",
      providerId: "daytona/custom",
    })).toBe("https://control.example.test/api/workspace/providers/daytona%2Fcustom/auth")
    expect(workspaceDefaultProviderUrl({ baseUrl: "https://control.example.test/" }))
      .toBe("https://control.example.test/api/workspace/providers/default")
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
  })

  test("builds experimental sandbox path", () => {
    expect(experimentalSandboxPath("workspace:ws_cloud"))
      .toBe("/api/experimental/sandbox?directory=workspace%3Aws_cloud")
  })

  test("workspace create surfaces do not import RuntimeGateway for stable route helpers", async () => {
    expect(await Bun.file(new URL("../../../features/workspaces/ui/dialogs/create-cloud-workspace.tsx", import.meta.url)).text())
      .not.toContain("RuntimeGateway")
    expect(await Bun.file(new URL("../../../features/workspaces/actions/project-actions.tsx", import.meta.url)).text())
      .not.toContain("RuntimeGateway")
  })
})
