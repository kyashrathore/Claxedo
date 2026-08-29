import { afterEach, describe, expect, mock, test } from "bun:test"

afterEach(() => {
  delete (globalThis as { api?: unknown }).api
})

describe("createCloudWorkspace", () => {
  test("desktop signed mode uses AccountPort workspace.create", async () => {
    const run = mock(async () => ({
      workspaceId: "ws_1",
      directory: "/workspace/ws_1",
    }))
    ;(globalThis as { api?: { account: Record<string, unknown> } }).api = {
      account: {
        run,
        state: async () => ({ status: "signed" }),
        onState: () => () => undefined,
        signIn: async () => ({ status: "signed" }),
        signOut: async () => ({ status: "unsigned" }),
      },
    }

    const { createCloudWorkspace } = await import("./workspace-create-api")
    const result = await createCloudWorkspace({
      projectName: "demo",
      workspaceName: "main",
      connectionId: "conn_1",
      repo: { fullName: "acme/demo" },
      driver: "daytona",
      baseUrl: "http://127.0.0.1:2593",
    })

    expect(result).toEqual({ workspaceId: "ws_1", directory: "/workspace/ws_1" })
    expect(run).toHaveBeenCalledWith("workspace.create", {
      projectName: "demo",
      workspaceName: "main",
      connectionId: "conn_1",
      repoFullName: "acme/demo",
    })
  })
})
