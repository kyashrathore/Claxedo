import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "../platform/auth/auth"
import type { WorkspaceAuthority } from "../platform/auth/authority"
import { ensureWorkspace, listProjects, listWorkspaces, updateProjectMetadata } from "../workspace/store/index"
import { localProjectStore, projectsDirectory, type LocalProjectStoreDeps } from "./local-store"
import { githubCloneAuthorization, type RepositoryAccessResult, type RepositorySourceDeps } from "./repository-source"
import { ProjectRoutes, type ProjectRouteOptions } from "./routes"
import { projectSlug } from "./store"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-projects-route-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

type Deps = LocalProjectStoreDeps & Pick<ProjectRouteOptions, "authority" | "authorizeFolderSource"> & RepositorySourceDeps

function routes(authenticate: ProjectRouteOptions["authenticate"], deps: Deps = {}) {
  const { clone, registerWorkspace, unregisterProject, authority, authorizeFolderSource, ...repositories } = deps
  return ProjectRoutes({
    store: localProjectStore({
      ...(clone ? { clone } : {}),
      ...(registerWorkspace ? { registerWorkspace } : {}),
      ...(unregisterProject ? { unregisterProject } : {}),
    }),
    authenticate,
    ...(authority ? { authority } : {}),
    ...(authorizeFolderSource ? { authorizeFolderSource } : {}),
    repositories,
  })
}

/** The unsigned local product: no caller identity at all. */
const unsigned: ProjectRouteOptions["authenticate"] = async () => undefined

/** A signed server: every request carries a bearer the verifier knows. */
function signedBy(verifier: (token: string) => Promise<SignedControlPlaneAuth>): ProjectRouteOptions["authenticate"] {
  return async (request) => {
    const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
    if (!token) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
    return verifier(token)
  }
}

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  await fs.rm(root, { recursive: true, force: true })
})

async function gitRepository(prefix: string) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(root, prefix)))
  execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "ignore" })
  return directory
}

/** Stands in for `git clone`: initialises a repository at the target. */
const clones: Array<{ repoUrl: string; options: unknown }> = []
async function fakeClone(repoUrl: string, directory: string, options?: unknown) {
  clones.push({ repoUrl, options: options ?? {} })
  await fs.mkdir(directory, { recursive: true })
  execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "ignore" })
}

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const post = (body: unknown, headers: Record<string, string>) => ({ ...json(body), headers: { "content-type": "application/json", ...headers } })

/**
 * Projects are machine-global rows here, so the authority is the only thing
 * that says which of them an account may reach: a row belongs to whoever
 * registered it, and an unclaimed row belongs to nobody.
 */
function ownerAuthority() {
  const owners = new Map<string, string>()
  return {
    claim: (projectId: string, subject: string) => void owners.set(projectId, subject),
    authority: {
      authorizeProject: async (auth: SignedControlPlaneAuth, args: { projectId: string }) =>
        owners.get(args.projectId) === auth.user.subject
          ? { ok: true, role: "owner", orgId: "org_1" }
          : { ok: false },
    } as unknown as WorkspaceAuthority,
  }
}

/** An `authorizeFolderSource`: deployment-wide authority, or a 403. */
function operatorOnly(subjects: string[]) {
  return (auth: SignedControlPlaneAuth) => {
    if (!subjects.includes(auth.user.subject)) {
      throw new ControlPlaneAuthError(403, "operator_required", "Deployment operator access is required")
    }
  }
}

describe("local project routes", () => {
  const app = routes(unsigned, { clone: fakeClone })

  test("a folder that already is a project is refused rather than renamed", async () => {
    const directory = await gitRepository("owned-")
    const first = await app.request("http://localhost/", json({ name: "Owner One", source: { kind: "directory", directory } }))
    expect(first.status).toBe(201)
    const again = await app.request("http://localhost/", json({ name: "Owner Two", source: { kind: "directory", directory } }))
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: { code: "project_directory_taken" } })
    const listed = await (await app.request("http://localhost/")).json() as { projects: Array<{ name: string }> }
    expect(listed.projects.map((item) => item.name)).toContain("Owner One")
    expect(listed.projects.map((item) => item.name)).not.toContain("Owner Two")
  })

  test("creates a project from a folder on this server, with its name and no execution", async () => {
    const directory = await gitRepository("folder-")
    const res = await app.request("http://localhost/", json({ name: "Folder Project", source: { kind: "directory", directory } }))
    expect(res.status).toBe(201)
    const { project } = await res.json() as { project: { id: string; name: string; directory: string; env: Record<string, string> } }
    expect(project).toMatchObject({ name: "Folder Project", directory, env: {} })
    expect(project.id).toBeTruthy()

    const listed = await (await app.request("http://localhost/")).json() as { projects: Array<{ name: string }> }
    expect(listed.projects.map((item) => item.name)).toContain("Folder Project")
  })

  test("refuses a folder that is not a git repository, and a folder that does not exist", async () => {
    const plain = await fs.mkdtemp(path.join(root, "plain-"))
    const notGit = await app.request("http://localhost/", json({ name: "Plain", source: { kind: "directory", directory: plain } }))
    expect(notGit.status).toBe(400)
    expect(((await notGit.json()) as { error: { code: string } }).error.code).toBe("project_not_git")
    const missing = await app.request("http://localhost/", json({ name: "Missing", source: { kind: "directory", directory: path.join(root, "nope") } }))
    expect(missing.status).toBe(400)
  })

  test("reads a folder written with ~ from the server's home, and refuses a relative path", async () => {
    const directory = await gitRepository("tilde-")
    const previousHome = process.env.HOME
    process.env.HOME = path.dirname(directory)
    try {
      const res = await app.request("http://localhost/", json({ name: "Tilde Project", source: { kind: "directory", directory: `~/${path.basename(directory)}` } }))
      expect(res.status).toBe(201)
      const { project } = await res.json() as { project: { directory: string } }
      expect(project.directory).toBe(directory)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    }
    const relative = await app.request("http://localhost/", json({ name: "Relative", source: { kind: "directory", directory: "code/app" } }))
    expect(relative.status).toBe(400)
    expect(((await relative.json()) as { error: { code: string } }).error.code).toBe("project_directory_relative")
  })

  test("names are unique per server, case-insensitively", async () => {
    const directory = await gitRepository("unique-")
    expect((await app.request("http://localhost/", json({ name: "Unique", source: { kind: "directory", directory } }))).status).toBe(201)
    const again = await app.request("http://localhost/", json({ name: "unique", source: { kind: "directory", directory: await gitRepository("unique2-") } }))
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("project_name_taken")
  })

  test("clones a repository under the data directory's projects folder, named by the project's slug", async () => {
    const res = await app.request("http://localhost/", json({
      name: "Repo Project",
      source: { kind: "repository", repoUrl: "https://github.com/acme/demo.git" },
      env: { NODE_ENV: "development" },
    }))
    expect(res.status).toBe(201)
    const { project } = await res.json() as { project: { directory: string; repoUrl: string; env: Record<string, string> } }
    // The store records real paths; on macOS the temp root is a symlink.
    expect(await fs.realpath(project.directory)).toBe(await fs.realpath(path.join(projectsDirectory(), "repo-project")))
    expect(project.repoUrl).toBe("https://github.com/acme/demo.git")
    expect(project.env).toEqual({ NODE_ENV: "development" })
    expect((await fs.stat(path.join(project.directory, ".git"))).isDirectory()).toBe(true)
  })

  test("a folder sent without a name is named by its origin remote, else by its folder", async () => {
    const withRemote = await gitRepository("named-")
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: withRemote, stdio: "ignore" })
    const named = await app.request("http://localhost/", json({ source: { kind: "directory", directory: withRemote } }))
    expect(named.status).toBe(201)
    expect(((await named.json()) as { project: { name: string } }).project.name).toBe("widgets")

    const scpRemote = await gitRepository("scp-")
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/gizmos.git"], { cwd: scpRemote, stdio: "ignore" })
    const scp = await app.request("http://localhost/", json({ source: { kind: "directory", directory: scpRemote } }))
    expect(((await scp.json()) as { project: { name: string } }).project.name).toBe("gizmos")

    const bare = await gitRepository("bare-")
    const byFolder = await app.request("http://localhost/", json({ source: { kind: "directory", directory: bare } }))
    expect(byFolder.status).toBe(201)
    expect(((await byFolder.json()) as { project: { name: string } }).project.name).toBe(path.basename(bare))
  })

  test("a derived name that another project bears takes the first free -2, -3 suffix; a sent one still 409s", async () => {
    for (const [remote, expected] of [
      ["https://github.com/acme/gadgets.git", "gadgets"],
      ["https://github.com/other/Gadgets", "Gadgets-2"],
      ["git@example.com:third/gadgets.git", "gadgets-3"],
    ]) {
      const directory = await gitRepository("clash-")
      execFileSync("git", ["remote", "add", "origin", remote], { cwd: directory, stdio: "ignore" })
      const res = await app.request("http://localhost/", json({ source: { kind: "directory", directory } }))
      expect(res.status).toBe(201)
      expect(((await res.json()) as { project: { name: string } }).project.name).toBe(expected)
    }
    const sent = await app.request("http://localhost/", json({ name: "Gadgets", source: { kind: "directory", directory: await gitRepository("sent-") } }))
    expect(sent.status).toBe(409)
    expect(await sent.json()).toMatchObject({ error: { code: "project_name_taken" } })
    const empty = await app.request("http://localhost/", json({ name: "  ", source: { kind: "directory", directory: await gitRepository("empty-") } }))
    expect(empty.status).toBe(400)
  })

  test("a repository sent without a name is named by the URL's last path segment", async () => {
    clones.length = 0
    const res = await app.request("http://localhost/", json({ source: { kind: "repository", repoUrl: "https://gitlab.com/acme/Nameless-Repo.git" } }))
    expect(res.status).toBe(201)
    const { project } = await res.json() as { project: { name: string; directory: string } }
    expect(project.name).toBe("Nameless-Repo")
    expect(await fs.realpath(project.directory)).toBe(await fs.realpath(path.join(projectsDirectory(), "nameless-repo")))
    expect(clones).toEqual([{ repoUrl: "https://gitlab.com/acme/Nameless-Repo.git", options: {} }])
  })

  test("the unsigned local product has no connections to clone through", async () => {
    const clone = vi.fn(fakeClone)
    const app = routes(unsigned, { clone })
    const res = await app.request("http://localhost/", json({
      source: { kind: "repository", connectionId: "conn_1", repo: { fullName: "acme/widgets" } },
    }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: "project_connection_requires_signin" } })
    expect(clone).not.toHaveBeenCalled()
  })

  test("refuses a repository source it cannot clone, and cleans up a failed clone", async () => {
    const invalid = await app.request("http://localhost/", json({ name: "Bad URL", source: { kind: "repository", repoUrl: "not a url" } }))
    expect(invalid.status).toBe(400)
    const failing = routes(unsigned, { clone: async () => { throw new Error("fatal: repository not found") } })
    const failed = await failing.request("http://localhost/", json({ name: "Gone", source: { kind: "repository", repoUrl: "https://github.com/acme/gone.git" } }))
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as { error: { message: string } }).error.message).toContain("repository not found")
    await expect(fs.stat(path.join(projectsDirectory(), "gone"))).rejects.toThrow()
  })

  test("updates a project's environment and name, refusing invalid names and taken names", async () => {
    const directory = await gitRepository("env-")
    const created = await (await app.request("http://localhost/", json({ name: "Env Project", source: { kind: "directory", directory } }))).json() as { project: { id: string } }
    const id = created.project.id

    const patched = await app.request(`http://localhost/${id}`, { ...json({ env: { DATABASE_URL: "postgres://localhost/demo" } }), method: "PATCH" })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { project: { env: Record<string, string> } }).project.env).toEqual({ DATABASE_URL: "postgres://localhost/demo" })

    const read = await app.request(`http://localhost/${id}`)
    expect(((await read.json()) as { project: { id: string; env: Record<string, string> } }).project).toMatchObject({ id, env: { DATABASE_URL: "postgres://localhost/demo" } })

    const badEnv = await app.request(`http://localhost/${id}`, { ...json({ env: { "bad name": "x" } }), method: "PATCH" })
    expect(badEnv.status).toBe(400)
    const taken = await app.request(`http://localhost/${id}`, { ...json({ name: "Folder Project" }), method: "PATCH" })
    expect(taken.status).toBe(409)
    const renamed = await app.request(`http://localhost/${id}`, { ...json({ name: "Env Project 2" }), method: "PATCH" })
    expect(((await renamed.json()) as { project: { name: string } }).project.name).toBe("Env Project 2")
  })

  test("reads one project by id, and answers 404 for an id it does not hold", async () => {
    const directory = await gitRepository("read-")
    const { project } = await (await app.request("http://localhost/", json({ name: "Read Me", source: { kind: "directory", directory } }))).json() as { project: { id: string } }
    const found = await app.request(`http://localhost/${project.id}`)
    expect(found.status).toBe(200)
    expect(((await found.json()) as { project: { name: string; directory: string } }).project).toMatchObject({ name: "Read Me", directory })
    const missing = await app.request("http://localhost/prj_nowhere")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: "project_not_found" } })
  })

  test("removing a project forgets it and its placements, and leaves the folder on disk", async () => {
    const directory = await gitRepository("remove-")
    const { project } = await (await app.request("http://localhost/", json({ name: "Removed", source: { kind: "directory", directory } }))).json() as { project: { id: string } }
    expect((await listWorkspaces()).some((workspace) => workspace.project_id === project.id)).toBe(true)
    const removed = await app.request(`http://localhost/${project.id}`, { method: "DELETE" })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ deleted: true })
    expect((await app.request(`http://localhost/${project.id}`)).status).toBe(404)
    expect((await app.request(`http://localhost/${project.id}`, { method: "DELETE" })).status).toBe(404)
    expect((await listWorkspaces()).some((workspace) => workspace.project_id === project.id)).toBe(false)
    expect((await fs.stat(path.join(directory, ".git"))).isDirectory()).toBe(true)
    // The folder is free to become a project again, under a new id.
    const again = await app.request("http://localhost/", json({ name: "Removed", source: { kind: "directory", directory } }))
    expect(again.status).toBe(201)
    expect(((await again.json()) as { project: { id: string } }).project.id).not.toBe(project.id)
  })

  test("lists every project the catalog holds, a folder registered without a record among them", async () => {
    const directory = await gitRepository("catalog-only-")
    const workspace = await ensureWorkspace({ directory, kind: "local" })
    const id = workspace?.project_id ?? ""
    const listed = await (await app.request("http://localhost/")).json() as { projects: Array<{ id: string }> }
    expect(listed.projects.find((project) => project.id === id)).toMatchObject({ name: path.basename(directory), directory, env: {}, available: true })
    expect((await app.request(`http://localhost/${id}`)).status).toBe(200)
  })

  test("a project whose folder is gone stays listed, marked unavailable", async () => {
    const directory = await gitRepository("vanished-")
    const { project } = await (await app.request("http://localhost/", json({ name: "Vanished", source: { kind: "directory", directory } }))).json() as { project: { id: string; available: boolean } }
    expect(project.available).toBe(true)
    await fs.rm(directory, { recursive: true, force: true })
    const listed = await (await app.request("http://localhost/")).json() as { projects: Array<{ id: string }> }
    expect(listed.projects.find((item) => item.id === project.id)).toMatchObject({ name: "Vanished", available: false })
  })

  test("a project whose folder is gone is recloned from its recorded remote into that same folder, once", async () => {
    const directory = await gitRepository("reclone-")
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/restore.git"], { cwd: directory, stdio: "ignore" })
    const { project } = await (await app.request("http://localhost/", json({ source: { kind: "directory", directory } }))).json() as { project: { id: string } }
    expect((await (await app.request(`http://localhost/${project.id}`)).json() as { project: object }).project).not.toHaveProperty("missingCheckout")
    await fs.rm(directory, { recursive: true, force: true })

    const gone = await (await app.request(`http://localhost/${project.id}`)).json() as { project: object }
    expect(gone.project).toMatchObject({ available: false, missingCheckout: { directory, remote: "https://github.com/acme/restore.git" } })

    clones.length = 0
    const res = await app.request(`http://localhost/${project.id}/reclone`, { method: "POST" })
    expect(res.status).toBe(200)
    const restored = (await res.json() as { project: object }).project
    expect(restored).toMatchObject({ id: project.id, directory, available: true })
    expect(restored).not.toHaveProperty("missingCheckout")
    expect(clones).toEqual([{ repoUrl: "https://github.com/acme/restore.git", options: {} }])
    expect((await fs.stat(path.join(directory, ".git"))).isDirectory()).toBe(true)

    const again = await app.request(`http://localhost/${project.id}/reclone`, { method: "POST" })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: { code: "project_checkout_present" } })
    expect(clones).toHaveLength(1)
    expect((await app.request("http://localhost/prj_absent/reclone", { method: "POST" })).status).toBe(404)
  })

  test("reclone refuses a project with no remote and a remote this server cannot clone, creating nothing", async () => {
    const bare = await gitRepository("reclone-bare-")
    const local = await gitRepository("reclone-local-")
    execFileSync("git", ["remote", "add", "origin", path.join(root, "elsewhere")], { cwd: local, stdio: "ignore" })
    const ids: string[] = []
    for (const directory of [bare, local]) {
      const { project } = await (await app.request("http://localhost/", json({ source: { kind: "directory", directory } }))).json() as { project: { id: string } }
      ids.push(project.id)
      await fs.rm(directory, { recursive: true, force: true })
    }
    clones.length = 0

    const noRemote = await app.request(`http://localhost/${ids[0]}/reclone`, { method: "POST" })
    expect(noRemote.status).toBe(409)
    expect(await noRemote.json()).toMatchObject({ error: { code: "project_remote_missing" } })
    const pathRemote = await app.request(`http://localhost/${ids[1]}/reclone`, { method: "POST" })
    expect(pathRemote.status).toBe(400)
    expect(await pathRemote.json()).toMatchObject({ error: { code: "project_repository_invalid" } })

    expect(clones).toEqual([])
    await expect(fs.stat(bare)).rejects.toThrow()
    await expect(fs.stat(local)).rejects.toThrow()
  })

  test("a failed reclone removes the folder it made and leaves the project missing", async () => {
    const directory = await gitRepository("reclone-fail-")
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/unreachable.git"], { cwd: directory, stdio: "ignore" })
    const { project } = await (await app.request("http://localhost/", json({ source: { kind: "directory", directory } }))).json() as { project: { id: string } }
    await fs.rm(directory, { recursive: true, force: true })
    const failing = routes(unsigned, {
      clone: async (_repoUrl, target) => {
        await fs.writeFile(path.join(target, "partial"), "x")
        throw new Error("fatal: repository 'https://github.com/acme/unreachable.git/' not found\nmore detail")
      },
    })

    const res = await failing.request(`http://localhost/${project.id}/reclone`, { method: "POST" })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: { code: "project_clone_failed", message: "Cloning failed: fatal: repository 'https://github.com/acme/unreachable.git/' not found" } })
    await expect(fs.stat(directory)).rejects.toThrow()
    expect((await (await app.request(`http://localhost/${project.id}`)).json() as { project: object }).project).toMatchObject({ missingCheckout: { directory } })
  })

  test("a project that runs only in a cloud workspace stays available, and its workspace is not reachable through this machine", async () => {
    const cloud = await ensureWorkspace({ kind: "cloud", driver: "modal", directory: "/workspace", repo_url: "https://github.com/acme/sky.git", status: "stopped" })
    const id = cloud?.project_id ?? ""
    const availability = async () => (((await (await app.request(`http://localhost/${id}`)).json()) as { project: { available: boolean } }).project.available)
    const reachable = async () => (await listProjects()).find((project) => project.id === id)?.workspaces[cloud?.id ?? ""]?.reachable
    expect(await availability()).toBe(true)
    expect(await reachable()).toBe(false)
  })

  test("the name is the catalog's: a rename there reads back here, one here reaches it, and an empty one restores the default", async () => {
    const directory = await gitRepository("one-name-")
    const { project } = await (await app.request("http://localhost/", json({ name: "One Name", source: { kind: "directory", directory } }))).json() as { project: { id: string } }
    const catalogName = async () => (await listProjects()).find((item) => item.id === project.id)?.name
    await updateProjectMetadata(project.id, { name: "Renamed Elsewhere" })
    expect(((await (await app.request(`http://localhost/${project.id}`)).json()) as { project: { name: string } }).project.name).toBe("Renamed Elsewhere")
    const renamed = await app.request(`http://localhost/${project.id}`, { ...json({ name: "Renamed Here" }), method: "PATCH" })
    expect(renamed.status).toBe(200)
    expect(((await renamed.json()) as { project: { name: string } }).project.name).toBe("Renamed Here")
    expect(await catalogName()).toBe("Renamed Here")
    const taken = await app.request("http://localhost/", json({ name: "renamed here", source: { kind: "directory", directory: await gitRepository("one-name-clash-") } }))
    expect(taken.status).toBe(409)
    const cleared = await app.request(`http://localhost/${project.id}`, { ...json({ name: "" }), method: "PATCH" })
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as { project: { name: string } }).project.name).toBe(path.basename(directory))
    expect(await catalogName()).toBe(path.basename(directory))
  })

  test("a project's icon and startup command are read and written through the route", async () => {
    const directory = await gitRepository("icon-")
    const { project } = await (await app.request("http://localhost/", json({ name: "Icon Project", source: { kind: "directory", directory } }))).json() as { project: { id: string } }
    const patched = await app.request(`http://localhost/${project.id}`, { ...json({ icon: { color: "mint", override: "data:image/png;base64,AA==" }, commands: { start: "bun install" } }), method: "PATCH" })
    expect(patched.status).toBe(200)
    const expected = { icon: { color: "mint", override: "data:image/png;base64,AA==" }, commands: { start: "bun install" } }
    expect(((await patched.json()) as { project: unknown }).project).toMatchObject(expected)
    expect(((await (await app.request("http://localhost/")).json()) as { projects: Array<{ id: string }> }).projects.find((item) => item.id === project.id)).toMatchObject(expected)
    expect((await listProjects()).find((item) => item.id === project.id)).toMatchObject(expected)
    const unknown = await app.request(`http://localhost/${project.id}`, { ...json({ icon: { shape: "round" } }), method: "PATCH" })
    expect(unknown.status).toBe(400)
  })

  test("removing a project the catalog holds without a record removes its workspace", async () => {
    const directory = await gitRepository("catalog-remove-")
    const workspace = await ensureWorkspace({ directory, kind: "local" })
    const id = workspace?.project_id ?? ""
    const removed = await app.request(`http://localhost/${id}`, { method: "DELETE" })
    expect(removed.status).toBe(200)
    expect((await listWorkspaces()).some((row) => row.id === workspace?.id)).toBe(false)
    expect((await app.request(`http://localhost/${id}`)).status).toBe(404)
    expect((await fs.stat(path.join(directory, ".git"))).isDirectory()).toBe(true)
  })

  test("a project with a cloud workspace is kept until that workspace is deleted", async () => {
    const directory = await gitRepository("cloudy-")
    const { project } = await (await app.request("http://localhost/", json({ name: "Cloudy", source: { kind: "directory", directory } }))).json() as { project: { id: string } }
    const cloud = await ensureWorkspace({ kind: "cloud", driver: "modal", project_id: project.id, directory: "/workspace", repo_url: "https://github.com/acme/cloudy.git" })
    expect(cloud?.project_id).toBe(project.id)
    const refused = await app.request(`http://localhost/${project.id}`, { method: "DELETE" })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: { code: "project_has_cloud_workspaces" } })
    expect((await app.request(`http://localhost/${project.id}`)).status).toBe(200)
  })
})

/**
 * On a signed server the route acts AS the caller: the workspace behind a new
 * project is registered with the caller's authority, because engine calls for
 * that directory are authorised against authority membership.
 */
describe("local project routes on a signed server", () => {
  const signed = {
    mode: "signed" as const,
    user: { subject: "usr_1", tokenIdentifier: "tok_1", issuer: "https://issuer.test" },
  }
  const authenticate = signedBy(async () => signed)
  const bearer = { authorization: "Bearer session-token" }
  const owners = ownerAuthority()
  /** What a signed composition must supply for a folder import; `usr_1` is this deployment's operator. */
  const signedDeps = {
    clone: fakeClone,
    authority: owners.authority,
    authorizeFolderSource: operatorOnly(["usr_1"]),
    // No real DNS in tests: clone admission resolves through this stub.
    admission: { resolve: async () => ["140.82.112.3"] },
  }
  const claiming = async (auth: SignedControlPlaneAuth, workspace: { projectId: string }) => {
    owners.claim(workspace.projectId, auth.user.subject)
  }

  test("registers the folder project's workspace for the signed caller", async () => {
    const registerWorkspace = vi.fn(claiming)
    const app = routes(authenticate, { ...signedDeps, registerWorkspace })
    const directory = await gitRepository("signed-")
    const res = await app.request("http://localhost/", {
      ...json({ name: "Signed Folder", source: { kind: "directory", directory } }),
      headers: { "content-type": "application/json", ...bearer },
    })
    expect(res.status).toBe(201)
    const { project } = await res.json() as { project: { id: string } }
    expect(registerWorkspace).toHaveBeenCalledTimes(1)
    const [auth, workspace] = registerWorkspace.mock.calls[0] as unknown as [typeof signed, { workspaceId: string; projectId: string; displayName: string; directory: string; repoUrl?: string }]
    expect(auth).toMatchObject({ mode: "signed", user: { subject: "usr_1" } })
    // The authority files the workspace under the project id this server
    // answers with; a different id hides the project from its creator.
    expect(workspace).toMatchObject({ projectId: project.id, displayName: "Signed Folder", directory })
    expect(workspace.workspaceId).toBeTruthy()
    expect(workspace.repoUrl).toBeUndefined()
  })

  test("a registration failure refuses the project instead of leaving it unreachable", async () => {
    const kept = routes(authenticate, { ...signedDeps, registerWorkspace: claiming })
    const keptDirectory = await gitRepository("kept-")
    expect((await kept.request("http://localhost/", post({ name: "Kept Folder", source: { kind: "directory", directory: keptDirectory } }, bearer))).status).toBe(201)

    const app = routes(authenticate, {
      ...signedDeps,
      registerWorkspace: async () => {
        throw new Error("Workspace creation authority was denied")
      },
    })
    const directory = await gitRepository("denied-")
    const res = await app.request("http://localhost/", post({ name: "Denied Folder", source: { kind: "directory", directory } }, bearer))
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: { code: "project_register_failed" } })
    const listed = await (await app.request("http://localhost/", { headers: bearer })).json() as { projects: Array<{ name: string }> }
    expect(listed.projects.map((item) => item.name)).toContain("Kept Folder")
    expect(listed.projects.map((item) => item.name)).not.toContain("Denied Folder")
  })

  /** A readable answer: the connection's repository row and the token that clones it. */
  const readable = (fullName: string, token: string) => ({
    ok: true as const,
    repository: {
      id: "1",
      name: fullName.split("/")[1] ?? fullName,
      fullName,
      cloneUrl: `https://github.com/${fullName}.git`,
      private: true,
      permissions: { read: true, write: false },
    },
    token,
  })
  const noConnection: RepositoryAccessResult = { ok: false, status: 404, code: "connection_not_found" }

  test("a pasted GitHub URL clones with the caller's connected account when it lists the repository as readable, off argv", async () => {
    const repositoryForAuth = vi.fn(async (auth: SignedControlPlaneAuth, connectionId: string | undefined, fullName: string) =>
      auth.user.subject === "usr_1" && connectionId === undefined && fullName === "acme/private"
        ? readable(fullName, "gho_secret")
        : noConnection)
    const app = routes(authenticate, { ...signedDeps, registerWorkspace: claiming, repositoryForAuth })
    clones.length = 0
    const res = await app.request("http://localhost/", post({ name: "Private Clone", source: { kind: "repository", repoUrl: "https://github.com/acme/private" } }, bearer))
    expect(res.status).toBe(201)
    expect(clones).toEqual([
      {
        repoUrl: "https://github.com/acme/private",
        options: { authorization: githubCloneAuthorization("gho_secret"), host: "github.com" },
      },
    ])
    expect(repositoryForAuth).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ subject: "usr_1" }) }), undefined, "acme/private")

    // A repository the connection does not list — a public one that is not
    // theirs — clones anonymously, as does one on a host they connected nothing for.
    const unlisted = await app.request("http://localhost/", post({ name: "Public Clone", source: { kind: "repository", repoUrl: "https://github.com/someone/public.git" } }, bearer))
    expect(unlisted.status).toBe(201)
    expect(clones[1]).toEqual({ repoUrl: "https://github.com/someone/public.git", options: {} })
    const other = await app.request("http://localhost/", post({ name: "Elsewhere Clone", source: { kind: "repository", repoUrl: "https://gitlab.com/acme/public" } }, bearer))
    expect(other.status).toBe(201)
    expect(clones[2]).toEqual({ repoUrl: "https://gitlab.com/acme/public", options: {} })
  })

  test("a GitHub token never rides to another host that happens to carry the same owner/repo", async () => {
    const app = routes(authenticate, {
      ...signedDeps,
      registerWorkspace: claiming,
      repositoryForAuth: async (_auth, _connectionId, fullName) => readable(fullName, "gho_secret"),
    })
    clones.length = 0
    const res = await app.request("http://localhost/", post({ name: "Same Name Elsewhere", source: { kind: "repository", repoUrl: "https://gitlab.com/acme/private" } }, bearer))
    expect(res.status).toBe(201)
    expect(clones).toEqual([{ repoUrl: "https://gitlab.com/acme/private", options: {} }])
  })

  test("a connections host that fails on a pasted URL is reported, not cloned around", async () => {
    const clone = vi.fn(fakeClone)
    const app = routes(authenticate, {
      ...signedDeps,
      clone,
      registerWorkspace: claiming,
      repositoryForAuth: async () => ({ ok: false, status: 502, code: "repository_provider_unavailable" }),
    })
    const res = await app.request("http://localhost/", post({ name: "Host Down", source: { kind: "repository", repoUrl: "https://github.com/acme/down" } }, bearer))
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: { code: "repository_provider_unavailable", message: expect.stringContaining("not available") } })
    expect(clone).not.toHaveBeenCalled()
  })

  test("a chosen connection resolves the clone URL and the token, and names the project by the repository", async () => {
    const repositoryForAuth = vi.fn(async (_auth: SignedControlPlaneAuth, connectionId: string | undefined, fullName: string) =>
      connectionId === "conn_1" ? readable(fullName, "gho_connection") : noConnection)
    const registerWorkspace = vi.fn(claiming)
    const app = routes(authenticate, { ...signedDeps, registerWorkspace, repositoryForAuth })
    clones.length = 0
    const res = await app.request("http://localhost/", post({
      source: { kind: "repository", connectionId: "conn_1", repo: { fullName: "acme/sprockets" } },
    }, bearer))
    expect(res.status).toBe(201)
    const { project } = await res.json() as { project: { name: string; repoUrl: string; directory: string } }
    expect(project.name).toBe("sprockets")
    expect(project.repoUrl).toBe("https://github.com/acme/sprockets.git")
    expect(await fs.realpath(project.directory)).toBe(await fs.realpath(path.join(projectsDirectory(), "sprockets")))
    expect(repositoryForAuth).toHaveBeenCalledTimes(1)
    expect(repositoryForAuth).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ subject: "usr_1" }) }), "conn_1", "acme/sprockets")
    expect(clones).toEqual([
      {
        repoUrl: "https://github.com/acme/sprockets.git",
        options: { authorization: githubCloneAuthorization("gho_connection"), host: "github.com" },
      },
    ])
    expect(registerWorkspace.mock.calls[0]?.[1]).toMatchObject({ displayName: "sprockets", repoUrl: "https://github.com/acme/sprockets.git" })
  })

  test("a connection that refuses the repository refuses the project, with nothing cloned or written", async () => {
    const clone = vi.fn(fakeClone)
    const refusing = routes(authenticate, {
      ...signedDeps,
      clone,
      registerWorkspace: claiming,
      repositoryForAuth: async () => ({ ok: false, status: 403, code: "repository_read_required" }),
    })
    const source = { kind: "repository" as const, connectionId: "conn_1", repo: { fullName: "acme/forbidden" } }
    const refused = await refusing.request("http://localhost/", post({ source }, bearer))
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: { code: "repository_read_required", message: expect.any(String) } })

    const throwing = routes(authenticate, {
      ...signedDeps,
      clone,
      registerWorkspace: claiming,
      repositoryForAuth: async () => {
        throw new Error("connections store is offline")
      },
    })
    const failed = await throwing.request("http://localhost/", post({ source }, bearer))
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({ error: { code: "project_repository_unavailable", message: expect.stringContaining("connections store is offline") } })

    expect(clone).not.toHaveBeenCalled()
    await expect(fs.stat(path.join(projectsDirectory(), "forbidden"))).rejects.toThrow()
    const listed = await (await refusing.request("http://localhost/", { headers: bearer })).json() as { projects: Array<{ name: string }> }
    expect(listed.projects.map((item) => item.name)).not.toContain("forbidden")
  })

  test("a connection's clone URL is held to the same destination rule as a pasted one", async () => {
    const clone = vi.fn(fakeClone)
    const app = routes(authenticate, {
      ...signedDeps,
      clone,
      registerWorkspace: claiming,
      admission: { resolve: async () => ["10.0.0.5"] },
      repositoryForAuth: async () => ({
        ...readable("acme/inside", "gho_secret"),
        repository: { ...readable("acme/inside", "gho_secret").repository, cloneUrl: "https://git.internal/acme/inside.git" },
      }),
    })
    const res = await app.request("http://localhost/", post({
      source: { kind: "repository", connectionId: "conn_1", repo: { fullName: "acme/inside" } },
    }, bearer))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: "project_repository_refused" } })
    expect(clone).not.toHaveBeenCalled()
  })

  test("a signed composition without connections cannot clone through one", async () => {
    const clone = vi.fn(fakeClone)
    const app = routes(authenticate, { ...signedDeps, clone, registerWorkspace: claiming })
    const res = await app.request("http://localhost/", post({
      source: { kind: "repository", connectionId: "conn_1", repo: { fullName: "acme/widgets" } },
    }, bearer))
    expect(res.status).toBe(501)
    expect(await res.json()).toMatchObject({ error: { code: "repository_connections_unavailable" } })
    expect(clone).not.toHaveBeenCalled()
  })

  test("a signed caller cannot clone into the server's own addresses", async () => {
    // S-12: remotely driven, `git clone` is a network reachability oracle into
    // whatever this server can dial. Private and loopback spellings, and names
    // whose DNS answers are private or absent, are refused before git runs.
    const clone = vi.fn(fakeClone)
    const resolveRepoAddresses = vi.fn(async (hostname: string) =>
      hostname === "private.internal" ? ["10.0.0.5"] : hostname === "nowhere.internal" ? [] : ["140.82.112.3"])
    const app = routes(authenticate, { ...signedDeps, clone, admission: { resolve: resolveRepoAddresses }, registerWorkspace: claiming })

    for (const repoUrl of [
      "http://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/acme/repo.git",
      "http://127.0.0.1:8080/acme/repo.git",
      "http://localhost:8080/acme/repo.git",
      "ssh://git@[::1]/acme/repo.git",
      "git@192.168.1.10:acme/repo.git",
      "https://private.internal/acme/repo.git",
      "https://nowhere.internal/acme/repo.git",
    ]) {
      const res = await app.request("http://localhost/", post({ name: `Refused ${repoUrl}`, source: { kind: "repository", repoUrl } }, bearer))
      expect(res.status, repoUrl).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: "project_repository_refused" } })
    }
    expect(clone).not.toHaveBeenCalled()
    expect(resolveRepoAddresses).toHaveBeenCalledWith("private.internal")
  })

  test("a signed caller's reclone holds the recorded remote to the same destination rule", async () => {
    const clone = vi.fn(fakeClone)
    const app = routes(authenticate, { ...signedDeps, clone, registerWorkspace: claiming })
    const directory = await gitRepository("signed-reclone-")
    execFileSync("git", ["remote", "add", "origin", "http://127.0.0.1:8080/acme/repo.git"], { cwd: directory, stdio: "ignore" })
    const created = await app.request("http://localhost/", post({ name: "Signed Reclone", source: { kind: "directory", directory } }, bearer))
    const { project } = await created.json() as { project: { id: string } }
    await fs.rm(directory, { recursive: true, force: true })

    const res = await app.request(`http://localhost/${project.id}/reclone`, { method: "POST", headers: bearer })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: "project_repository_refused" } })
    expect(clone).not.toHaveBeenCalled()
    await expect(fs.stat(directory)).rejects.toThrow()
  })

  test("a signed caller may clone a private host the operator explicitly approved", async () => {
    const clone = vi.fn(fakeClone)
    const resolveRepoAddresses = vi.fn(async () => ["10.0.0.5"])
    const app = routes(authenticate, {
      ...signedDeps,
      clone,
      admission: { resolve: resolveRepoAddresses, privateHosts: ["git.corp.internal"] },
      registerWorkspace: claiming,
    })
    const approved = await app.request("http://localhost/", post({
      name: "Corp Clone",
      source: { kind: "repository", repoUrl: "https://git.corp.internal/acme/repo.git" },
    }, bearer))
    expect(approved.status).toBe(201)
    expect(clone).toHaveBeenCalledTimes(1)
    // Approval is an exact-name policy, not a lookup.
    expect(resolveRepoAddresses).not.toHaveBeenCalled()
  })

  test("the unsigned local product never registers", async () => {
    const registerWorkspace = vi.fn(async () => undefined)
    const app = routes(unsigned, { clone: fakeClone, registerWorkspace })
    const directory = await gitRepository("unsigned-")
    const res = await app.request("http://localhost/", json({ name: "Unsigned Folder", source: { kind: "directory", directory } }))
    expect(res.status).toBe(201)
    expect(registerWorkspace).not.toHaveBeenCalled()
  })

  test("removing a signed caller's project retires it in their authority first", async () => {
    const unregisterProject = vi.fn(async () => undefined)
    const app = routes(authenticate, { ...signedDeps, registerWorkspace: claiming, unregisterProject })
    const directory = await gitRepository("signed-remove-")
    const { project } = await (await app.request("http://localhost/", post({ name: "Signed Removed", source: { kind: "directory", directory } }, bearer))).json() as { project: { id: string } }
    const workspaceIds = (await listWorkspaces()).filter((workspace) => workspace.project_id === project.id).map((workspace) => workspace.id)
    expect(workspaceIds).toHaveLength(1)
    const removed = await app.request(`http://localhost/${project.id}`, { method: "DELETE", headers: bearer })
    expect(removed.status).toBe(200)
    expect(unregisterProject).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ subject: "usr_1" }) }),
      { projectId: project.id, workspaceIds },
    )
    expect((await app.request(`http://localhost/${project.id}`, { headers: bearer })).status).toBe(404)
  })

  test("a signed composition that cannot retire the project in the authority refuses to remove it", async () => {
    const app = routes(authenticate, { ...signedDeps, registerWorkspace: claiming })
    const directory = await gitRepository("signed-kept-")
    const { project } = await (await app.request("http://localhost/", post({ name: "Signed Kept", source: { kind: "directory", directory } }, bearer))).json() as { project: { id: string } }
    const refused = await app.request(`http://localhost/${project.id}`, { method: "DELETE", headers: bearer })
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ error: { code: "authority_unavailable" } })
    expect((await app.request(`http://localhost/${project.id}`, { headers: bearer })).status).toBe(200)
  })
})

/**
 * A signed server is reachable by everyone who holds an account on it, and the
 * project store it answers from is one machine-wide list. Two unrelated
 * accounts therefore say everything about this router: which of them may point
 * the server at a folder of their choosing, and which of them may read or
 * rewrite a row it already holds.
 */
describe("project authorization between two unrelated signed accounts", () => {
  const accounts: Record<string, SignedControlPlaneAuth> = {
    "operator-token": { mode: "signed", user: { subject: "usr_operator", tokenIdentifier: "tok_operator", issuer: "https://issuer.test" } },
    "stranger-token": { mode: "signed", user: { subject: "usr_stranger", tokenIdentifier: "tok_stranger", issuer: "https://issuer.test" } },
  }
  const authenticate = signedBy(async (token) => {
    const account = accounts[token]
    if (!account) throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Unknown session token")
    return account
  })
  const asOperator = { authorization: "Bearer operator-token" }
  const asStranger = { authorization: "Bearer stranger-token" }
  const owners = ownerAuthority()
  const app = routes(authenticate, {
    clone: fakeClone,
    authority: owners.authority,
    authorizeFolderSource: operatorOnly(["usr_operator"]),
    admission: { resolve: async () => ["140.82.112.3"] },
    registerWorkspace: async (auth, workspace) => {
      owners.claim(workspace.projectId, auth.user.subject)
    },
  })

  test("a non-operator cannot point the server at a folder, and is refused before it reads one", async () => {
    const directory = await gitRepository("stranger-")
    const denied = await app.request("http://localhost/", post({ name: "Stranger Folder", source: { kind: "directory", directory } }, asStranger))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: { code: "operator_required" } })

    // A path that was never created answers the same 403 rather than
    // `project_directory_missing`, which is what says the refusal lands before
    // the route stats anything on this server's disk.
    const probe = await app.request("http://localhost/", post({ name: "Probe", source: { kind: "directory", directory: path.join(root, "absent") } }, asStranger))
    expect(probe.status).toBe(403)

    const listed = await (await app.request("http://localhost/", { headers: asStranger })).json() as { projects: unknown[] }
    expect(listed.projects).toEqual([])
  })

  test("the operator's project is invisible, unreadable and unwritable to the other account", async () => {
    const directory = await gitRepository("operator-")
    const created = await app.request("http://localhost/", post({
      name: "Operator Folder",
      source: { kind: "directory", directory },
      env: { DEPLOY_KEY: "operator-only-secret" },
    }, asOperator))
    expect(created.status).toBe(201)
    const { project } = await created.json() as { project: { id: string; env: Record<string, string> } }
    expect(project.env).toEqual({ DEPLOY_KEY: "operator-only-secret" })

    const mine = await (await app.request("http://localhost/", { headers: asOperator })).json() as { projects: Array<{ id: string; env: Record<string, string> }> }
    expect(mine.projects.map((item) => item.id)).toEqual([project.id])

    const theirs = await app.request("http://localhost/", { headers: asStranger })
    expect(await theirs.text()).not.toContain("operator-only-secret")

    const strangerRead = await app.request(`http://localhost/${project.id}`, { headers: asStranger })
    expect(strangerRead.status).toBe(404)
    expect(await strangerRead.json()).toMatchObject({ error: { code: "project_not_found" } })
    expect((await app.request(`http://localhost/${project.id}`, { headers: asOperator })).status).toBe(200)

    const rewritten = await app.request(`http://localhost/${project.id}`, {
      ...post({ name: "Stranger Owned", env: { DEPLOY_KEY: "attacker-supplied" } }, asStranger),
      method: "PATCH",
    })
    expect(rewritten.status).toBe(403)
    expect(await rewritten.json()).toMatchObject({ error: { code: "project_access_denied" } })

    const after = await (await app.request(`http://localhost/${project.id}`, { headers: asOperator })).json() as { project: { name: string; env: Record<string, string> } }
    expect(after.project).toMatchObject({ name: "Operator Folder", env: { DEPLOY_KEY: "operator-only-secret" } })
  })

  test("a signed composition missing its authorization dependencies reads nothing", async () => {
    const directory = await gitRepository("failclosed-read-")
    const bare = routes(authenticate, { clone: fakeClone })
    expect((await bare.request("http://localhost/", { headers: asOperator })).status).toBe(503)
    expect((await bare.request(`http://localhost/prj_1`, { headers: asOperator })).status).toBe(503)
    expect((await bare.request(`http://localhost/prj_1`, { ...post({ name: "Renamed" }, asOperator), method: "PATCH" })).status).toBe(503)

    const withoutOperator = routes(authenticate, { clone: fakeClone, authority: owners.authority })
    const importAttempt = await withoutOperator.request("http://localhost/", post({ name: "Fail Closed", source: { kind: "directory", directory } }, asOperator))
    expect(importAttempt.status).toBe(503)
    expect(await importAttempt.json()).toMatchObject({ error: { code: "authority_unavailable" } })
  })

  test("a signed create refuses before it clones or writes when nothing can bind the result to the caller", async () => {
    const directory = await gitRepository("failclosed-write-")
    const name = "Fail Closed Create"
    const repoUrl = "https://github.com/acme/fail-closed-create"
    const cloneTarget = path.join(projectsDirectory(), projectSlug(name))

    const cases = [
      // No authority: the workspace would belong to no account at all.
      ["workspace_authority_unavailable", {
        authorizeFolderSource: operatorOnly(["usr_operator"]),
        registerWorkspace: async () => undefined,
      }],
      // An authority, but nothing that files the new workspace under the caller.
      ["authority_unavailable", {
        authority: owners.authority,
        authorizeFolderSource: operatorOnly(["usr_operator"]),
      }],
    ] as const

    for (const [code, deps] of cases) {
      const clone = vi.fn(fakeClone)
      const app = routes(authenticate, { clone, ...deps })
      for (const source of [{ kind: "repository" as const, repoUrl }, { kind: "directory" as const, directory }]) {
        const refused = await app.request("http://localhost/", post({ name, source }, asOperator))
        expect(refused.status).toBe(503)
        expect(await refused.json()).toMatchObject({ error: { code } })
      }
      expect(clone).not.toHaveBeenCalled()
      await expect(fs.stat(cloneTarget)).rejects.toThrow()
    }

    // Nothing above was persisted: a fully composed server still takes that
    // name and that folder, which a stored project would answer 409 to.
    const composed = routes(authenticate, {
      clone: fakeClone,
      authority: owners.authority,
      authorizeFolderSource: operatorOnly(["usr_operator"]),
      registerWorkspace: async (auth, workspace) => {
        owners.claim(workspace.projectId, auth.user.subject)
      },
    })
    const created = await composed.request("http://localhost/", post({ name, source: { kind: "directory", directory } }, asOperator))
    expect(created.status).toBe(201)
  })

  test("the unsigned local product still creates projects with none of those dependencies", async () => {
    const app = routes(unsigned, { clone: fakeClone })
    const directory = await gitRepository("unsigned-create-")
    expect((await app.request("http://localhost/", json({ name: "Unsigned Directory", source: { kind: "directory", directory } }))).status).toBe(201)
    expect((await app.request("http://localhost/", json({ name: "Unsigned Repository", source: { kind: "repository", repoUrl: "https://github.com/acme/unsigned" } }))).status).toBe(201)
    const listed = await (await app.request("http://localhost/")).json() as { projects: Array<{ name: string }> }
    expect(listed.projects.map((item) => item.name)).toEqual(expect.arrayContaining(["Unsigned Directory", "Unsigned Repository"]))
  })

  test("only the owner removes a project; a stranger's delete changes nothing", async () => {
    const directory = await gitRepository("operator-remove-")
    const { project } = await (await app.request("http://localhost/", post({ name: "Operator Kept", source: { kind: "directory", directory } }, asOperator))).json() as { project: { id: string } }
    const denied = await app.request(`http://localhost/${project.id}`, { method: "DELETE", headers: asStranger })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: { code: "project_access_denied" } })
    expect((await app.request(`http://localhost/${project.id}`, { headers: asOperator })).status).toBe(200)
  })
})

/**
 * Every test above hands the routes a `clone` stand-in, so the git child the
 * product actually starts was never exercised. These serve a real repository
 * over loopback HTTP — git's dumb protocol is static files — and let the
 * default clone fetch it.
 */
describe("the clone this server really runs", () => {
  let origin = ""
  let requests: Array<{ url: string; authorization: string }> = []
  let server: import("node:http").Server

  beforeAll(async () => {
    const source = await gitRepository("clone-origin-")
    // No line ending, so a checkout under `core.autocrlf` has nothing to
    // rewrite and reads back the bytes committed.
    await fs.writeFile(path.join(source, "README.md"), "# origin")
    execFileSync("git", ["add", "README.md"], { cwd: source, stdio: "ignore" })
    execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-m", "init"], {
      cwd: source,
      stdio: "ignore",
    })
    const served = path.join(root, "served.git")
    execFileSync("git", ["clone", "--bare", source, served], { stdio: "ignore" })
    execFileSync("git", ["update-server-info"], { cwd: served, stdio: "ignore" })

    const http = await import("node:http")
    server = http.createServer((request, response) => {
      const url = (request.url ?? "").split("?")[0] ?? ""
      requests.push({ url, authorization: request.headers.authorization ?? "" })
      fs.readFile(path.join(served, url.replace(/^\/served\.git/, "")))
        .then((body) => response.writeHead(200).end(body))
        .catch(() => response.writeHead(404).end())
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/served.git`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test("fetches the repository into the project's folder and sends no credential it was not given", async () => {
    requests = []
    const app = routes(unsigned, {})
    const created = await app.request("http://localhost/", json({ name: "Served Clone", source: { kind: "repository", repoUrl: origin } }))
    expect(created.status).toBe(201)
    const { project } = await created.json() as { project: { directory: string; repoUrl: string } }
    expect(project.repoUrl).toBe(origin)
    expect(await fs.readFile(path.join(project.directory, "README.md"), "utf8")).toBe("# origin")
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.map((item) => item.authorization)).toEqual(requests.map(() => ""))
  })

  test("reclones a deleted folder project from its origin into the folder it was registered at", async () => {
    const app = routes(unsigned, {})
    const directory = path.join(await gitRepository("served-parent-"), "nested", "checkout")
    await fs.mkdir(directory, { recursive: true })
    execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "ignore" })
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: directory, stdio: "ignore" })
    const created = await app.request("http://localhost/", json({ name: "Served Reclone", source: { kind: "directory", directory } }))
    expect(created.status).toBe(201)
    const { project } = await created.json() as { project: { id: string } }
    await fs.rm(path.dirname(path.dirname(directory)), { recursive: true, force: true })

    const res = await app.request(`http://localhost/${project.id}/reclone`, { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ project: { id: project.id, directory, available: true } })
    expect(await fs.readFile(path.join(directory, "README.md"), "utf8")).toBe("# origin")
    expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: directory, encoding: "utf8" }).trim()).toBe(origin)
  })

  test("reports the git child's own failure when the repository is not there", async () => {
    const app = routes(unsigned, {})
    const failed = await app.request("http://localhost/", json({
      name: "Served Missing",
      source: { kind: "repository", repoUrl: origin.replace("/served.git", "/absent.git") },
    }))
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as { error: { message: string } }).error.message).toContain("absent.git")
    await expect(fs.stat(path.join(projectsDirectory(), "served-missing"))).rejects.toThrow()
  })
})
