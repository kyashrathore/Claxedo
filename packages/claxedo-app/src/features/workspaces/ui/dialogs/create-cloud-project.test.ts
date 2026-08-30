import { describe, expect, test } from "bun:test"

describe("create cloud project dialog transport", () => {
  test("routes workspace create through the named AccountPort helper", async () => {
    const source = await Bun.file(new URL("./create-cloud-project.tsx", import.meta.url)).text()

    expect(source).not.toContain("RuntimeGateway")
    expect(source).not.toContain('from "../../../settings/ui/sandbox-section-logic"')
    expect(source).toContain('from "@/platform/runtime/agent/workspace-control-routes"')
    expect(source).toContain('from "@/features/workspaces/data/workspace-create-api"')
    expect(source).toContain("createCloudWorkspace(")
    expect(source).toContain("workspaceSandboxDriversUrl({ baseUrl })")
    expect(source).toContain("workspaceResolveUrl({ baseUrl, workspaceId })")
    expect(source).not.toContain("workspaceCreateUrl({ baseUrl })")
  })
})
