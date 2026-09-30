import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "shell-project-current-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root
const [{ ShellRoutes }, workspaceStore] = await Promise.all([
  import("./routes"),
  import("@claxedo/server-core/workspace/store/index"),
])
const unsigned = { enabled: false, mode: "local-only", reason: "local test" } as const
let app: ReturnType<typeof ShellRoutes>

// None of these directories exists here, so every row is placed on the
// provisioner. The store refuses a provisioner row that names no driver — the
// driver IS the machine it runs on — and a refused row leaves the routes below
// asserting about an empty project.
beforeEach(async () => {
  process.env.CLAXEDO_DATA_DIR = await fs.mkdtemp(path.join(root, "case-"))
  await workspaceStore.ensureWorkspace({ workspaceId: "ws_main", project_id: "project_a", org_id: "org_a", project_name: "Original", workspace_name: "main", kind: "cloud", driver: "modal", directory: "/srv/a" })
  await workspaceStore.ensureWorkspace({ workspaceId: "ws_child", project_id: "project_a", org_id: "org_a", workspace_name: "branch", kind: "cloud", driver: "modal", directory: "/srv/branch" })
  await workspaceStore.ensureWorkspace({ workspaceId: "ws_other", project_id: "project_b", org_id: "org_b", project_name: "Other", kind: "cloud", driver: "modal", directory: "/srv/b" })
  app = ShellRoutes({ authConfig: unsigned })
})
afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  await fs.rm(root, { recursive: true, force: true })
})

describe("GET /project/current", () => {
  test("answers the project a child workspace belongs to, by the project's identity", async () => {
    const current = await app.request("/project/current?workspaceId=ws_child")
    expect(current.status).toBe(200)
    const project = await current.json()
    expect(project).toMatchObject({ id: "project_a", worktree: "ws_main", name: "Original" })
    expect(Object.keys(project.workspaces).sort()).toEqual(["ws_child", "ws_main"])
  })

  test("resolves a directory without registering it", async () => {
    const directory = path.join(root, "current-read")
    await fs.mkdir(directory)
    execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "ignore" })
    const query = `directory=${encodeURIComponent(directory)}`

    for (let attempt = 0; attempt < 2; attempt++) {
      const missing = await app.request(`/project/current?${query}`)
      expect(missing.status).toBe(404)
    }
    expect(await workspaceStore.resolveWorkspace({ directory })).toBeUndefined()
  })

  test("a signed caller reads only the projects the authority grants, whatever workspace it names", async () => {
    const authorizeProject = vi.fn(async (_auth: unknown, input: { projectId: string; action: string }) => ({ ok: input.projectId === "project_a" && input.action === "read" }))
    const options = {
      authConfig: { enabled: true as const, issuer: "https://auth.test", jwksUrl: "custom:test" },
      verifier: async (token: string) => ({ mode: "signed" as const, user: { subject: token, issuer: "https://auth.test", tokenIdentifier: token } }),
      services: { authority: { authorizeProject } } as unknown as ControlPlaneServicesContract,
    }
    const signed = ShellRoutes(options)
    const headers = { authorization: "Bearer viewer" }
    expect((await signed.request("/project/current?workspaceId=ws_main")).status).toBe(401)
    expect((await signed.request("/project/current?workspaceId=ws_child", { headers })).status).toBe(200)
    expect((await signed.request("/project/current?workspaceId=ws_other", { headers })).status).toBe(404)
    expect(authorizeProject).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ subject: "viewer" }) }), { projectId: "project_b", action: "read" })
    const unavailable = ShellRoutes({ ...options, services: undefined })
    expect((await unavailable.request("/project/current?workspaceId=ws_main", { headers })).status).toBe(503)
  })
})
