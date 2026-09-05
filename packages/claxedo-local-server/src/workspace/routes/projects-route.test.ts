import { afterAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-projects-route-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { LocalProjectRoutes, projectsDirectory } = await import("./projects-route")
const { vi } = await import("vitest")

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

describe("local project routes", () => {
  const app = LocalProjectRoutes({}, { clone: fakeClone })

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

  test("refuses a repository source it cannot clone, and cleans up a failed clone", async () => {
    const invalid = await app.request("http://localhost/", json({ name: "Bad URL", source: { kind: "repository", repoUrl: "not a url" } }))
    expect(invalid.status).toBe(400)
    const failing = LocalProjectRoutes({}, { clone: async () => { throw new Error("fatal: repository not found") } })
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

    const byDirectory = await app.request(`http://localhost/by-directory?directory=${encodeURIComponent(directory)}`)
    expect(((await byDirectory.json()) as { project: { id: string; env: Record<string, string> } }).project).toMatchObject({ id, env: { DATABASE_URL: "postgres://localhost/demo" } })

    const badEnv = await app.request(`http://localhost/${id}`, { ...json({ env: { "bad name": "x" } }), method: "PATCH" })
    expect(badEnv.status).toBe(400)
    const taken = await app.request(`http://localhost/${id}`, { ...json({ name: "Folder Project" }), method: "PATCH" })
    expect(taken.status).toBe(409)
    const renamed = await app.request(`http://localhost/${id}`, { ...json({ name: "Env Project 2" }), method: "PATCH" })
    expect(((await renamed.json()) as { project: { name: string } }).project.name).toBe("Env Project 2")
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
  const options = {
    authConfig: { enabled: true as const, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks" },
    verifier: async () => signed,
  }
  const bearer = { authorization: "Bearer session-token" }

  test("registers the folder project's workspace for the signed caller", async () => {
    const registerWorkspace = vi.fn(async () => undefined)
    const app = LocalProjectRoutes(options, { clone: fakeClone, registerWorkspace })
    const directory = await gitRepository("signed-")
    const res = await app.request("http://localhost/", {
      ...json({ name: "Signed Folder", source: { kind: "directory", directory } }),
      headers: { "content-type": "application/json", ...bearer },
    })
    expect(res.status).toBe(201)
    expect(registerWorkspace).toHaveBeenCalledTimes(1)
    const [auth, workspace] = registerWorkspace.mock.calls[0] as unknown as [typeof signed, { workspaceId: string; displayName: string; directory: string; repoUrl?: string }]
    expect(auth).toMatchObject({ mode: "signed", user: { subject: "usr_1" } })
    expect(workspace).toMatchObject({ displayName: "Signed Folder", directory })
    expect(workspace.workspaceId).toBeTruthy()
    expect(workspace.repoUrl).toBeUndefined()
  })

  test("a registration failure refuses the project instead of leaving it unreachable", async () => {
    const app = LocalProjectRoutes(options, {
      clone: fakeClone,
      registerWorkspace: async () => {
        throw new Error("Workspace creation authority was denied")
      },
    })
    const directory = await gitRepository("denied-")
    const res = await app.request("http://localhost/", {
      ...json({ name: "Denied Folder", source: { kind: "directory", directory } }),
      headers: { "content-type": "application/json", ...bearer },
    })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: { code: "project_register_failed" } })
    const listed = await (await app.request("http://localhost/", { headers: bearer })).json() as { projects: Array<{ name: string }> }
    expect(listed.projects.map((item) => item.name)).not.toContain("Denied Folder")
  })

  test("clones a GitHub repository with the caller's connected-account credential, off argv", async () => {
    const { githubCloneAuthorization } = await import("./projects-route")
    const app = LocalProjectRoutes(options, {
      clone: fakeClone,
      registerWorkspace: async () => undefined,
      cloneCredential: async (auth, repoUrl) =>
        auth.user.subject === "usr_1" && repoUrl.startsWith("https://github.com/")
          ? { authorization: githubCloneAuthorization("gho_secret") }
          : undefined,
    })
    clones.length = 0
    const res = await app.request("http://localhost/", {
      ...json({ name: "Private Clone", source: { kind: "repository", repoUrl: "https://github.com/acme/private" } }),
      headers: { "content-type": "application/json", ...bearer },
    })
    expect(res.status).toBe(201)
    expect(clones).toEqual([
      {
        repoUrl: "https://github.com/acme/private",
        options: { authorization: githubCloneAuthorization("gho_secret"), host: "github.com" },
      },
    ])
    const other = await app.request("http://localhost/", {
      ...json({ name: "Elsewhere Clone", source: { kind: "repository", repoUrl: "https://gitlab.com/acme/public" } }),
      headers: { "content-type": "application/json", ...bearer },
    })
    expect(other.status).toBe(201)
    expect(clones[1]).toEqual({ repoUrl: "https://gitlab.com/acme/public", options: {} })
  })

  test("the unsigned local product never registers", async () => {
    const registerWorkspace = vi.fn(async () => undefined)
    const app = LocalProjectRoutes({}, { clone: fakeClone, registerWorkspace })
    const directory = await gitRepository("unsigned-")
    const res = await app.request("http://localhost/", json({ name: "Unsigned Folder", source: { kind: "directory", directory } }))
    expect(res.status).toBe(201)
    expect(registerWorkspace).not.toHaveBeenCalled()
  })
})
