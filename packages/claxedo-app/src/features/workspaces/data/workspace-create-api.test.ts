import { afterEach, describe, expect, mock, test } from "bun:test"

const originalFetch = globalThis.fetch

afterEach(() => {
  delete (globalThis as { api?: unknown }).api
  globalThis.fetch = originalFetch
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

  test("a 200 without a workspaceId rejects with a readable message, not the validator's issue list", async () => {
    globalThis.fetch = mock(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))

    const { createCloudWorkspace } = await import("./workspace-create-api")
    const failure = await createCloudWorkspace({ projectId: "prj_1", baseUrl: "http://127.0.0.1:2593" }).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toBe("Workspace create returned an invalid response (workspaceId: Invalid input: expected string, received undefined)")
    expect(message).not.toContain("{")
  })
})

describe("cloudWorkspaceSource", () => {
  test("a URL clones by URL, a connected repository by connection, and a folder cannot", async () => {
    const { cloudWorkspaceSource } = await import("./workspace-create-api")
    expect(cloudWorkspaceSource({ kind: "repository", repoUrl: "https://github.com/acme/app" })).toEqual({ repoUrl: "https://github.com/acme/app" })
    expect(cloudWorkspaceSource({ kind: "repository", connectionId: "conn_1", repo: { fullName: "acme/app" } })).toEqual({
      connectionId: "conn_1",
      repo: { fullName: "acme/app" },
    })
    expect(() => cloudWorkspaceSource({ kind: "directory", folder: "/home/me/app" })).toThrow("a folder on a machine cannot start one")
  })
})
