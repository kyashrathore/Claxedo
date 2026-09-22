import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "shell-project-metadata-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root
const [{ ShellRoutes }, workspaceStore, { BootstrapRoutes }] = await Promise.all([
  import("./routes"),
  import("@claxedo/server-core/workspace/store/index"),
  import("../deployments/shared-routes/bootstrap"),
])
const unsigned = { enabled: false, mode: "local-only", reason: "local test" } as const
let app: ReturnType<typeof ShellRoutes>

// None of these directories exists here, so every row is placed on the
// provisioner. The store refuses a provisioner row that names no driver — the
// driver IS the machine it runs on — and a refused row leaves the routes below
// asserting about an empty project.
beforeEach(async () => {
  process.env.CLAXEDO_DATA_DIR = await fs.mkdtemp(path.join(root, "case-"))
  await workspaceStore.ensureWorkspace({ workspaceId: "ws_main", project_id: "project_a", org_id: "org_a", project_name: "Original", workspace_name: "main", kind: "cloud", driver: "daytona", directory: "/srv/a" })
  await workspaceStore.ensureWorkspace({ workspaceId: "ws_child", project_id: "project_a", org_id: "org_a", workspace_name: "branch", kind: "cloud", driver: "daytona", directory: "/srv/branch" })
  await workspaceStore.ensureWorkspace({ workspaceId: "ws_other", project_id: "project_b", org_id: "org_b", project_name: "Other", kind: "cloud", driver: "daytona", directory: "/srv/b" })
  app = ShellRoutes({ authConfig: unsigned })
})
afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  await fs.rm(root, { recursive: true, force: true })
})

const patch = (body: unknown, token?: string) => ({ method: "PATCH", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })

describe("Claxedo project metadata public routes", () => {
  test("updates canonical project metadata and reloads it without changing project or workspace identity", async () => {
    const notify = vi.fn()
    const unsubscribe = workspaceStore.subscribeLocalWorkspaceChanges(notify)
    try {
      const response = await app.request("/project/project_a", patch({ name: "Renamed", icon: { color: "blue", override: "data:image/png;base64,aGVsbG8=" }, commands: { start: "bun dev" } }))
      expect(response.status).toBe(200)
      const updated = await response.json()
      expect(updated).toMatchObject({ id: "project_a", worktree: "ws_main", name: "Renamed", icon: { color: "blue", override: "data:image/png;base64,aGVsbG8=" }, commands: { start: "bun dev" } })
      expect(Object.keys(updated.workspaces).sort()).toEqual(["ws_child", "ws_main"])
      expect(notify).toHaveBeenCalledTimes(1)
      const savedDirectory = process.env.CLAXEDO_DATA_DIR!
      process.env.CLAXEDO_DATA_DIR = await fs.mkdtemp(path.join(root, "reload-"))
      expect(await (await app.request("/project")).json()).toEqual([])
      process.env.CLAXEDO_DATA_DIR = savedDirectory
      const current = await app.request("/project/current?workspaceId=ws_child")
      expect(current.status).toBe(200)
      expect(await current.json()).toEqual(updated)
      const other = (await (await app.request("/project")).json()).find((item: { id: string }) => item.id === "project_b")
      expect(other.name).toBe("Other")
      expect(other.icon).toBeUndefined()
    } finally { unsubscribe() }
  })

  test("partial edits preserve siblings and empty strings clear overrides", async () => {
    await app.request("/project/project_a", patch({ name: "Custom", icon: { color: "blue", override: "image" }, commands: { start: "bun dev" } }))
    const response = await app.request("/project/project_a", patch({ name: "", icon: { override: "" }, commands: { start: "" } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: "project_a", name: "main", icon: { color: "blue", override: "" }, commands: { start: "" } })
  })

  test("parallel edits preserve both independent fields after reload", async () => {
    const responses = await Promise.all([
      app.request("/project/project_a", patch({ name: "Concurrent" })),
      app.request("/project/project_a", patch({ icon: { color: "green" } })),
      app.request("/project/project_a", patch({ icon: { override: "concurrent-image" } })),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
    const savedDirectory = process.env.CLAXEDO_DATA_DIR!
    process.env.CLAXEDO_DATA_DIR = await fs.mkdtemp(path.join(root, "parallel-reload-"))
    await workspaceStore.listProjects()
    process.env.CLAXEDO_DATA_DIR = savedDirectory
    expect(await (await app.request("/project/current?workspaceId=ws_main")).json()).toMatchObject({ name: "Concurrent", icon: { color: "green", override: "concurrent-image" } })
  })

  test.each([{ id: "project_b" }, { directory: "/srv/b" }, { name: null }, { icon: { color: 123 } }, { commands: { unknown: "exec" } }])("rejects invalid metadata without mutating identity or state: %j", async (body) => {
    const before = await fs.readFile(path.join(process.env.CLAXEDO_DATA_DIR!, "workspaces.json"), "utf8")
    expect((await app.request("/project/project_a", patch(body))).status).toBe(400)
    expect(await fs.readFile(path.join(process.env.CLAXEDO_DATA_DIR!, "workspaces.json"), "utf8")).toBe(before)
  })

  test("GET /project/current resolves without registering; POST registers for the local product", async () => {
    const directory = path.join(root, "current-ensure")
    await fs.mkdir(directory)
    execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "ignore" })
    const query = `directory=${encodeURIComponent(directory)}`

    // The read verb never writes, however often it runs.
    for (let attempt = 0; attempt < 2; attempt++) {
      const missing = await app.request(`/project/current?${query}`)
      expect(missing.status).toBe(404)
    }
    expect(await workspaceStore.resolveWorkspace({ directory })).toBeUndefined()

    const ensured = await app.request(`/project/current?${query}`, { method: "POST" })
    expect(ensured.status).toBe(200)
    const project = await ensured.json()
    expect(await workspaceStore.resolveWorkspace({ directory })).toMatchObject({ project_id: project.id })
    // The read now answers what the write registered.
    expect((await app.request(`/project/current?${query}`)).status).toBe(200)
  })

  test("rejects missing projects and never adopts a child workspace ID as project identity", async () => {
    for (const id of ["missing", "ws_child"]) expect((await app.request(`/project/${id}`, patch({ name: "wrong" }))).status).toBe(404)
    expect((await workspaceStore.listProjects()).map((project) => project.id).sort()).toEqual(["project_a", "project_b"])
  })

  test("signed routes enforce read/write authority rather than caller-supplied workspace hints", async () => {
    const authorizeProject = vi.fn(async (auth: { user: { subject: string } }, input: { projectId: string; action: string }) => {
      const readable = input.projectId === (auth.user.subject === "other" ? "project_b" : "project_a")
      return { ok: readable && (input.action === "read" || auth.user.subject === "owner") }
    })
    const options = {
      authConfig: { enabled: true as const, issuer: "https://auth.test", jwksUrl: "custom:test" },
      verifier: async (token: string) => ({ mode: "signed" as const, user: { subject: token, issuer: "https://auth.test", tokenIdentifier: token } }),
      services: { authority: { authorizeProject } } as unknown as ControlPlaneServicesContract,
    }
    const signed = ShellRoutes(options)
    expect((await signed.request("/project/project_a", patch({ name: "denied" }))).status).toBe(401)
    expect((await signed.request("/project/project_a?workspaceId=ws_other", patch({ name: "denied" }, "other"))).status).toBe(403)
    expect((await signed.request("/project/project_a", patch({ name: "denied" }, "viewer"))).status).toBe(403)
    expect((await workspaceStore.listProjects()).find((project) => project.id === "project_a")?.name).toBe("Original")
    const headers = { authorization: "Bearer viewer" }
    expect((await (await signed.request("/project", { headers })).json()).map((project: { id: string }) => project.id)).toEqual(["project_a"])
    expect((await signed.request("/project/current?workspaceId=ws_other", { headers })).status).toBe(404)
    // The ensure verb is a read for a signed caller too: registering a
    // directory goes through POST /api/claxedo/projects under the authority.
    const foreign = path.join(root, "foreign")
    await fs.mkdir(foreign)
    execFileSync("git", ["init", "-b", "main"], { cwd: foreign, stdio: "ignore" })
    const before = (await workspaceStore.listWorkspaces()).length
    expect((await signed.request(`/project/current?directory=${encodeURIComponent(foreign)}`, { method: "POST", headers })).status).toBe(404)
    expect((await workspaceStore.listWorkspaces()).length).toBe(before)
    expect((await signed.request("/project/project_a", patch({ name: "Allowed" }, "owner"))).status).toBe(200)
    expect((await workspaceStore.listProjects()).find((project) => project.id === "project_a")?.name).toBe("Allowed")
    expect(authorizeProject).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ subject: "other" }) }), { projectId: "project_a", action: "write" })
    const unavailable = ShellRoutes({ ...options, services: undefined })
    expect((await unavailable.request("/project/project_a", patch({ name: "denied" }, "owner"))).status).toBe(503)
  })

  test("signed bootstrap replays edited metadata only for authority-visible projects", async () => {
    const options = {
      authConfig: { enabled: true as const, issuer: "https://auth.test", jwksUrl: "custom:test" },
      verifier: async (token: string) => ({ mode: "signed" as const, user: { subject: token, issuer: "https://auth.test", tokenIdentifier: token } }),
      services: { authority: {
        authorizeProject: async (auth: { user: { subject: string } }, input: { projectId: string }) => ({ ok: auth.user.subject === "owner" && input.projectId === "project_a" }),
        listWorkspaces: async () => [{ workspace_id: "ws_main", project_id: "project_a", display_name: "Authority name" }],
      } } as unknown as ControlPlaneServicesContract,
    }
    const signed = ShellRoutes(options)
    expect((await signed.request("/project/project_a", patch({ name: "Shared name", icon: { color: "purple" }, commands: { start: "bun dev" } }, "owner"))).status).toBe(200)
    await app.request("/project/project_b", patch({ icon: { override: "private-marker" }, commands: { start: "private-command" } }))
    const response = await BootstrapRoutes({ ...options, hostAggregateEvents: false }).request("http://control.example/api/claxedo/bootstrap", { headers: { authorization: "Bearer owner" } })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.project).toHaveLength(1)
    expect(body.project[0]).toMatchObject({ id: "project_a", name: "Shared name", worktree: "ws_main", icon: { color: "purple" }, commands: { start: "bun dev" } })
    expect(JSON.stringify(body)).not.toContain("private-")
    expect(JSON.stringify(body)).not.toContain("project_b")
  })
})
