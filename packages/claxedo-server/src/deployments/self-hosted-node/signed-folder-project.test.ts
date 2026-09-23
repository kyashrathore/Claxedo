import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { realDirectoryPath } from "@claxedo/helpers/real-path"

// A folder project created by a signed caller on the self-hosted server, seen
// through the routes the web app reads: the project list this server answers
// for itself, and the signed workspace resolve. Both must name the same
// workspace on its real directory, or the app treats the folder as a
// workspace served by some other machine.

let dataDir: string
let previousEnv: Record<string, string | undefined>
let services: Awaited<ReturnType<typeof import("./app").createDefaultLocalControlPlaneServices>>
let composed: ReturnType<typeof import("./app").createSelfHostedApp>
let owner: Awaited<ReturnType<typeof signUp>>
let stranger: typeof owner

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-signed-folder-"))
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
  // Both accounts exist before the app is composed, because the operator set is
  // read once at composition and the subject it names is minted by sign-up.
  const embedded = getEmbeddedAuth()
  await embedded.ready
  const signedUp = await Promise.all(
    ["folder-owner@selfhost.test", "someone-else@selfhost.test"].map((email) => signUp(embedded.handler, email)),
  )
  owner = signedUp[0]!
  stranger = signedUp[1]!
  process.env.CLAXEDO_OPERATOR_SUBJECTS = owner.id
  const { createDefaultLocalControlPlaneServices, createSelfHostedApp, embeddedManagedPrivateSessionPolicy } =
    await import("./app")
  services = createDefaultLocalControlPlaneServices()
  composed = createSelfHostedApp(services)
  // What `startOwnedControlPlaneStack` injects on a signed deployment, and the
  // reason `POST /session` there refuses a create without a reservation. The
  // catalog assertion below reads the same object, so the row the app trusts
  // cannot drift from the policy the runtimes are mounted with.
  const { configureEmbeddedWorkspaceRuntime } = await import("@claxedo/local-server/self-hosted-execution")
  const authority = services.authority
  if (!authority) throw new Error("signed self-hosted services expose a workspace authority")
  configureEmbeddedWorkspaceRuntime({
    sessionAccessPolicy: embeddedManagedPrivateSessionPolicy(authority),
  })
})

afterAll(async () => {
  const { configureEmbeddedWorkspaceRuntime } = await import("@claxedo/local-server/self-hosted-execution")
  configureEmbeddedWorkspaceRuntime({})
  await composed.dispose()
  services.close()
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

function gitRepository() {
  const directory = realDirectoryPath(fs.mkdtempSync(path.join(dataDir, "repo-")))
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory, stdio: "ignore" })
  return directory
}

describe("a folder project on the signed self-hosted server", () => {
  test("is listed by /project and resolves to its real directory for its creator", async () => {
    const headers = owner.headers
    const directory = gitRepository()

    const created = await composed.app.request("/api/claxedo/projects", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "live-check", source: { kind: "directory", directory } }),
    })
    expect(created.status).toBe(201)
    const { project } = await created.json() as { project: { id: string; directory: string | null } }
    expect(project.directory).toBe(directory)

    const listed = await composed.app.request("/project", { headers })
    expect(listed.status).toBe(200)
    const projects = await listed.json() as Array<{
      id: string
      worktree: string
      workspaces: Record<string, { id: string; kind: string; session_authority?: string }>
    }>
    expect(projects.map((item) => item.id)).toEqual([project.id])
    expect(projects[0]).toMatchObject({ worktree: directory })
    expect(Object.values(projects[0].workspaces).map((workspace) => workspace.kind)).toEqual(["local"])
    // The app reaches this workspace over loopback but must still reserve
    // before `POST /session`, because this composition injected a managed
    // authority into its embedded runtimes. Nothing on the client can derive
    // that, so the catalog row states it.
    expect(Object.values(projects[0].workspaces).map((workspace) => workspace.session_authority))
      .toEqual(["managed-private"])

    const resolved = await composed.app.request(
      `/api/workspace/resolve?directory=${encodeURIComponent(directory)}`,
      { headers },
    )
    expect(resolved.status).toBe(200)
    const body = await resolved.json() as Record<string, unknown>
    expect(body).toMatchObject({
      workspaceId: Object.keys(projects[0].workspaces)[0],
      projectId: project.id,
      directory,
      backing: { kind: "local-worktree" },
    })
    // The authority answers for a workspace whose machine it does not serve, so
    // it states the placement and no inventory kind. A client that read a kind
    // here would take it for the attached server's own word and open a loopback
    // runtime for a directory on somebody else's filesystem.
    expect(body).not.toHaveProperty("kind")
  })

  test("stays hidden from a different signed user", async () => {
    const listed = await composed.app.request("/project", { headers: stranger.headers })
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toEqual([])
  })
})
