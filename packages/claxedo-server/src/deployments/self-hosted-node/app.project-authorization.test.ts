import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { realDirectoryPath } from "@claxedo/helpers/real-path"

// Project administration on a signed self-hosted box, driven through the real
// composed app by two accounts that share nothing. The project store this
// server answers from is one machine-wide list and its rows carry the
// environment a sandbox starts with, so who may add a row, read one and rewrite
// one are three separate questions this exercises separately.

let dataDir: string
let previousEnv: Record<string, string | undefined>
let services: Awaited<ReturnType<typeof import("./app").createDefaultLocalControlPlaneServices>>
let composed: ReturnType<typeof import("./app").createSelfHostedApp>
let operator: Awaited<ReturnType<typeof signUp>>
let stranger: typeof operator

async function signUp(handler: (request: Request) => Promise<Response>, email: string) {
  const res = await handler(new Request("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: email }),
  }))
  expect(res.status).toBe(200)
  const token = res.headers.get("set-auth-token")
  expect(token).toBeTruthy()
  const body = await res.json() as { user: { id: string } }
  return { id: body.user.id, headers: { authorization: `Bearer ${token}` } }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-project-authorization-"))
  previousEnv = {
    CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
    CLAXEDO_SIGNED_CLOUD_AUTH: process.env.CLAXEDO_SIGNED_CLOUD_AUTH,
    CLAXEDO_EMBEDDED_AUTH: process.env.CLAXEDO_EMBEDDED_AUTH,
    CLAXEDO_OPERATOR_SUBJECTS: process.env.CLAXEDO_OPERATOR_SUBJECTS,
  }
  process.env.CLAXEDO_DATA_DIR = dataDir
  process.env.CLAXEDO_SIGNED_CLOUD_AUTH = "1"
  process.env.CLAXEDO_EMBEDDED_AUTH = "1"
  const { resetEmbeddedAuthForTests, getEmbeddedAuth } = await import("./embedded-auth")
  resetEmbeddedAuthForTests()
  // The operator set is read once at composition and names a subject only
  // sign-up can mint, so both accounts exist before the app does.
  const embedded = getEmbeddedAuth()
  await embedded.ready
  const signedUp = await Promise.all(
    ["deployment-operator@selfhost.test", "unrelated-account@selfhost.test"].map((email) => signUp(embedded.handler, email)),
  )
  operator = signedUp[0]!
  stranger = signedUp[1]!
  process.env.CLAXEDO_OPERATOR_SUBJECTS = operator.id
  const { createDefaultLocalControlPlaneServices, createSelfHostedApp } = await import("./app")
  services = createDefaultLocalControlPlaneServices()
  composed = createSelfHostedApp(services)
})

afterAll(async () => {
  await composed?.dispose()
  services?.close()
  const { closeAuthorityDatabases } = await import(
    "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
  )
  closeAuthorityDatabases()
  const { resetEmbeddedAuthForTests } = await import("./embedded-auth")
  resetEmbeddedAuthForTests()
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function gitRepository(prefix: string) {
  const directory = realDirectoryPath(fs.mkdtempSync(path.join(dataDir, prefix)))
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory, stdio: "ignore" })
  return directory
}

function createProject(headers: Record<string, string>, body: unknown) {
  return composed.app.request("/api/claxedo/projects", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("project administration on the signed self-hosted server", () => {
  test("only the deployment operator can point this server at a folder it already holds", async () => {
    const directory = gitRepository("stranger-")
    const denied = await createProject(stranger.headers, { name: "Stranger Folder", source: { kind: "directory", directory } })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: { code: "operator_required" } })

    // A path this server never had answers the same 403 instead of
    // `project_directory_missing`, which is what shows the refusal lands before
    // the route reads anything off the filesystem.
    const probe = await createProject(stranger.headers, {
      name: "Probe",
      source: { kind: "directory", directory: path.join(dataDir, "never-created") },
    })
    expect(probe.status).toBe(403)

    const anonymous = await createProject({}, { name: "Anonymous Folder", source: { kind: "directory", directory } })
    expect(anonymous.status).toBe(401)

    // Neither refusal wrote a row: the operator still imports that same folder,
    // which a claimed one would answer with `project_directory_taken`.
    const imported = await createProject(operator.headers, { name: "Stranger Folder", source: { kind: "directory", directory } })
    expect(imported.status).toBe(201)
  })

  test("the operator's project and its environment stay out of the other account's reach", async () => {
    const directory = gitRepository("operator-")
    const created = await createProject(operator.headers, {
      name: "Operator Folder",
      source: { kind: "directory", directory },
      env: { DEPLOY_KEY: "operator-only-secret" },
    })
    expect(created.status).toBe(201)
    const { project } = await created.json() as { project: { id: string; directory: string; env: Record<string, string> } }
    expect(project).toMatchObject({ directory, env: { DEPLOY_KEY: "operator-only-secret" } })

    const mine = await composed.app.request("/api/claxedo/projects", { headers: operator.headers })
    const listedForOperator = await mine.json() as { projects: Array<{ id: string }> }
    expect(listedForOperator.projects.map((item) => item.id)).toContain(project.id)

    // The store holds every row the operator just listed, and the other account
    // is answered none of them — not a filtered copy carrying the environment.
    const theirs = await composed.app.request("/api/claxedo/projects", { headers: stranger.headers })
    expect(theirs.status).toBe(200)
    const listedForStranger = await theirs.text()
    expect(JSON.parse(listedForStranger)).toEqual({ projects: [] })
    expect(listedForStranger).not.toContain("operator-only-secret")

    const query = `?directory=${encodeURIComponent(directory)}`
    expect((await composed.app.request(`/api/claxedo/projects/by-directory${query}`, { headers: operator.headers })).status).toBe(200)
    const hidden = await composed.app.request(`/api/claxedo/projects/by-directory${query}`, { headers: stranger.headers })
    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toMatchObject({ error: { code: "project_not_found" } })

    const rewritten = await composed.app.request(`/api/claxedo/projects/${project.id}`, {
      method: "PATCH",
      headers: { ...stranger.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Stranger Owned", env: { DEPLOY_KEY: "attacker-supplied" } }),
    })
    expect(rewritten.status).toBe(403)
    expect(await rewritten.json()).toMatchObject({ error: { code: "project_access_denied" } })

    const after = await composed.app.request(`/api/claxedo/projects/by-directory${query}`, { headers: operator.headers })
    const stored = await after.json() as { project: { name: string; env: Record<string, string> } }
    expect(stored.project).toMatchObject({ name: "Operator Folder", env: { DEPLOY_KEY: "operator-only-secret" } })
  })

  test("the operator holds the machine, not every account's projects: their own update lands", async () => {
    const directory = gitRepository("owned-")
    const created = await createProject(operator.headers, { name: "Owned Folder", source: { kind: "directory", directory } })
    expect(created.status).toBe(201)
    const { project } = await created.json() as { project: { id: string } }

    const updated = await composed.app.request(`/api/claxedo/projects/${project.id}`, {
      method: "PATCH",
      headers: { ...operator.headers, "content-type": "application/json" },
      body: JSON.stringify({ env: { DATABASE_URL: "postgres://localhost/demo" } }),
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ project: { id: project.id, env: { DATABASE_URL: "postgres://localhost/demo" } } })
  })
})
