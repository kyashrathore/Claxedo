import { afterAll, beforeAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-projects-route-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { LocalProjectRoutes, projectsDirectory, projectSlug } = await import("./projects-route")
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

/** `selfHostedOperatorAuthorizer`'s contract: deployment-wide authority, or a 403. */
function operatorOnly(subjects: string[]) {
  return (auth: SignedControlPlaneAuth) => {
    if (!subjects.includes(auth.user.subject)) {
      throw new ControlPlaneAuthError(403, "operator_required", "Deployment operator access is required")
    }
  }
}

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
  const owners = ownerAuthority()
  /** What a signed composition must supply for a folder import; `usr_1` is this deployment's operator. */
  const signedDeps = {
    clone: fakeClone,
    authority: owners.authority,
    authorizeLocalDirectoryImport: operatorOnly(["usr_1"]),
  }
  const claiming = async (auth: SignedControlPlaneAuth, workspace: { projectId: string }) => {
    owners.claim(workspace.projectId, auth.user.subject)
  }

  test("registers the folder project's workspace for the signed caller", async () => {
    const registerWorkspace = vi.fn(claiming)
    const app = LocalProjectRoutes(options, { ...signedDeps, registerWorkspace })
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
    // answers `/project` with; a different id hides the project from its creator.
    expect(workspace).toMatchObject({ projectId: project.id, displayName: "Signed Folder", directory })
    expect(workspace.workspaceId).toBeTruthy()
    expect(workspace.repoUrl).toBeUndefined()
  })

  test("a registration failure refuses the project instead of leaving it unreachable", async () => {
    const kept = LocalProjectRoutes(options, { ...signedDeps, registerWorkspace: claiming })
    const keptDirectory = await gitRepository("kept-")
    expect((await kept.request("http://localhost/", post({ name: "Kept Folder", source: { kind: "directory", directory: keptDirectory } }, bearer))).status).toBe(201)

    const app = LocalProjectRoutes(options, {
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

  test("clones a GitHub repository with the caller's connected-account credential, off argv", async () => {
    const { githubCloneAuthorization } = await import("./projects-route")
    const app = LocalProjectRoutes(options, {
      ...signedDeps,
      registerWorkspace: claiming,
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
  const options = {
    authConfig: { enabled: true as const, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks" },
    verifier: async (token: string) => {
      const account = accounts[token]
      if (!account) throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Unknown session token")
      return account
    },
  }
  const asOperator = { authorization: "Bearer operator-token" }
  const asStranger = { authorization: "Bearer stranger-token" }
  const owners = ownerAuthority()
  const app = LocalProjectRoutes(options, {
    clone: fakeClone,
    authority: owners.authority,
    authorizeLocalDirectoryImport: operatorOnly(["usr_operator"]),
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

    const byDirectory = await app.request(`http://localhost/by-directory?directory=${encodeURIComponent(directory)}`, { headers: asStranger })
    expect(byDirectory.status).toBe(404)
    expect(await byDirectory.json()).toMatchObject({ error: { code: "project_not_found" } })
    expect((await app.request(`http://localhost/by-directory?directory=${encodeURIComponent(directory)}`, { headers: asOperator })).status).toBe(200)

    const rewritten = await app.request(`http://localhost/${project.id}`, {
      ...post({ name: "Stranger Owned", env: { DEPLOY_KEY: "attacker-supplied" } }, asStranger),
      method: "PATCH",
    })
    expect(rewritten.status).toBe(403)
    expect(await rewritten.json()).toMatchObject({ error: { code: "project_access_denied" } })

    const after = await (await app.request(`http://localhost/by-directory?directory=${encodeURIComponent(directory)}`, { headers: asOperator })).json() as { project: { name: string; env: Record<string, string> } }
    expect(after.project).toMatchObject({ name: "Operator Folder", env: { DEPLOY_KEY: "operator-only-secret" } })
  })

  test("a signed composition missing its authorization dependencies reads nothing", async () => {
    const directory = await gitRepository("failclosed-read-")
    const bare = LocalProjectRoutes(options, { clone: fakeClone })
    expect((await bare.request("http://localhost/", { headers: asOperator })).status).toBe(503)
    expect((await bare.request(`http://localhost/by-directory?directory=${encodeURIComponent(directory)}`, { headers: asOperator })).status).toBe(503)
    expect((await bare.request(`http://localhost/prj_1`, { ...post({ name: "Renamed" }, asOperator), method: "PATCH" })).status).toBe(503)

    const withoutOperator = LocalProjectRoutes(options, { clone: fakeClone, authority: owners.authority })
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
        authorizeLocalDirectoryImport: operatorOnly(["usr_operator"]),
        registerWorkspace: async () => undefined,
      }],
      // An authority, but nothing that files the new workspace under the caller.
      ["authority_unavailable", {
        authority: owners.authority,
        authorizeLocalDirectoryImport: operatorOnly(["usr_operator"]),
      }],
    ] as const

    for (const [code, deps] of cases) {
      const clone = vi.fn(fakeClone)
      const app = LocalProjectRoutes(options, { clone, ...deps })
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
    const composed = LocalProjectRoutes(options, {
      clone: fakeClone,
      authority: owners.authority,
      authorizeLocalDirectoryImport: operatorOnly(["usr_operator"]),
      registerWorkspace: async (auth, workspace) => {
        owners.claim(workspace.projectId, auth.user.subject)
      },
    })
    const created = await composed.request("http://localhost/", post({ name, source: { kind: "directory", directory } }, asOperator))
    expect(created.status).toBe(201)
  })

  test("the unsigned local product still creates projects with none of those dependencies", async () => {
    const app = LocalProjectRoutes({}, { clone: fakeClone })
    const directory = await gitRepository("unsigned-create-")
    expect((await app.request("http://localhost/", json({ name: "Unsigned Directory", source: { kind: "directory", directory } }))).status).toBe(201)
    expect((await app.request("http://localhost/", json({ name: "Unsigned Repository", source: { kind: "repository", repoUrl: "https://github.com/acme/unsigned" } }))).status).toBe(201)
    const listed = await (await app.request("http://localhost/")).json() as { projects: Array<{ name: string }> }
    expect(listed.projects.map((item) => item.name)).toEqual(expect.arrayContaining(["Unsigned Directory", "Unsigned Repository"]))
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
    await fs.writeFile(path.join(source, "README.md"), "# origin\n")
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
    const app = LocalProjectRoutes({}, {})
    const created = await app.request("http://localhost/", json({ name: "Served Clone", source: { kind: "repository", repoUrl: origin } }))
    expect(created.status).toBe(201)
    const { project } = await created.json() as { project: { directory: string; repoUrl: string } }
    expect(project.repoUrl).toBe(origin)
    expect(await fs.readFile(path.join(project.directory, "README.md"), "utf8")).toBe("# origin\n")
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.map((item) => item.authorization)).toEqual(requests.map(() => ""))
  })

  test("reports the git child's own failure when the repository is not there", async () => {
    const app = LocalProjectRoutes({}, {})
    const failed = await app.request("http://localhost/", json({
      name: "Served Missing",
      source: { kind: "repository", repoUrl: `${origin.replace("/served.git", "/absent.git")}` },
    }))
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as { error: { message: string } }).error.message).toContain("absent.git")
    await expect(fs.stat(path.join(projectsDirectory(), "served-missing"))).rejects.toThrow()
  })
})
