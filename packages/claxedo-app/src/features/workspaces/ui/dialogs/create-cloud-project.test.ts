import { describe, expect, test } from "bun:test"

describe("create cloud project dialog transport", () => {
  test("keeps workspace control-plane URLs local to the component", async () => {
    const source = await Bun.file(new URL("./create-cloud-project.tsx", import.meta.url)).text()

    expect(source).not.toContain("RuntimeGateway")
    expect(source).not.toContain('from "../../../settings/ui/sandbox-section-logic"')
    expect(source).toContain('from "@/platform/runtime/agent/workspace-control-routes"')
    expect(source).toContain("workspaceProvidersUrl({ baseUrl })")
    expect(source).toContain("workspaceCreateUrl({ baseUrl })")
    expect(source).toContain("workspaceResolveUrl({ baseUrl, workspaceId })")
  })
})
