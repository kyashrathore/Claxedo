import fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases, openAuthorityDb } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { ensureWorkspace, getWorkspace } from "@claxedo/server-core/workspace/store/index"
import { createDefaultLocalControlPlaneServices, createSelfHostedApp } from "./app"
import { getEmbeddedAuth, resetEmbeddedAuthForTests } from "./embedded-auth"

/**
 * The shipped signed self-hosted app, its real embedded issuer and its real
 * SQLite authority: two accounts that both signed in successfully, and the
 * lifecycle verbs asked which of them may act on each stored workspace.
 */
let root: string
let services: ReturnType<typeof createDefaultLocalControlPlaneServices>
let composed: ReturnType<typeof createSelfHostedApp>
let operator: { id: string; headers: Record<string, string> }
let stranger: typeof operator

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-workspace-lifecycle-auth-"))
  vi.stubEnv("CLAXEDO_DATA_DIR", root)
  vi.stubEnv("CLAXEDO_STATE_DIR", path.join(root, "state"))
  vi.stubEnv("CLAXEDO_EMBEDDED_AUTH", "1")
  vi.stubEnv("CLAXEDO_DEPLOYMENT_MODE", "local")
  vi.stubEnv("CLAXEDO_CHANNELS_ENABLED", "0")
  vi.stubEnv("BETTER_AUTH_URL", "http://selfhost.test")
  resetEmbeddedAuthForTests()
  const embedded = getEmbeddedAuth()
  await embedded.ready
  async function signup(email: string) {
    const response = await embedded.handler(new Request("http://selfhost.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "synthetic-test-password", name: email }),
    }))
    expect(response.status).toBe(200)
    const token = response.headers.get("set-auth-token")
    expect(token).toBeTruthy()
    const body = await response.json() as { user: { id: string } }
    return { id: body.user.id, headers: { authorization: `Bearer ${token}` } }
  }
  operator = await signup("operator@example.test")
  stranger = await signup("stranger@example.test")
  vi.stubEnv("CLAXEDO_OPERATOR_SUBJECTS", operator.id)
  services = createDefaultLocalControlPlaneServices()
  composed = createSelfHostedApp(services)
})

afterAll(async () => {
  await composed?.dispose()
  services?.close()
  ClaxedoDB.close()
  closeAuthorityDatabases()
  resetEmbeddedAuthForTests()
  vi.unstubAllEnvs()
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test("a workspace placed on this machine is deleted by its operator and by no other signed account", async () => {
  const directory = path.join(root, "machine-workspace")
  await fs.mkdir(directory, { recursive: true })
  // The store files a new machine placement only for a git checkout.
  const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { stdio: "ignore" })
  git("init", "-b", "main")
  git("config", "user.email", "operator@example.test")
  git("config", "user.name", "Operator")
  await fs.writeFile(path.join(directory, "README.md"), "machine workspace")
  git("add", "README.md")
  git("commit", "-m", "machine workspace")
  expect(await ensureWorkspace({
    workspaceId: "ws_machine_local",
    project_id: "project_machine_local",
    org_id: "org_machine_local",
    directory,
  })).toMatchObject({ id: "ws_machine_local", kind: "local" })

  const refused = await composed.app.request("http://selfhost.test/api/workspace/ws_machine_local", {
    method: "DELETE",
    headers: stranger.headers,
  })
  expect(refused.status).toBe(403)
  expect(await refused.json()).toMatchObject({ error: { code: "operator_required" } })
  expect(await getWorkspace("ws_machine_local")).toMatchObject({ id: "ws_machine_local" })

  const deleted = await composed.app.request("http://selfhost.test/api/workspace/ws_machine_local", {
    method: "DELETE",
    headers: operator.headers,
  })
  expect(deleted.status).toBe(200)
  expect(await getWorkspace("ws_machine_local")).toBeUndefined()
})

// Only the refusal runs against the mounted app: everything after the
// admission reads this developer machine's provider environment, and a test
// that got past it could provision a real sandbox. The admitted path is
// exercised where the provisioner is a fixture (`workspace/routes/index.test.ts`)
// and where the store is real (`authority/adapters/*/workspace-authority.test.ts`).
test("an organization the caller has no authority in is refused before any provisioning work", async () => {
  const denied = await composed.app.request("http://selfhost.test/api/workspace/create", {
    method: "POST",
    headers: { ...stranger.headers, "content-type": "application/json" },
    body: JSON.stringify({ orgId: "org_machine_local", repoUrl: "https://github.com/acme/demo.git" }),
  })

  expect(denied.status).toBe(403)
  expect(await denied.json()).toMatchObject({ error: { code: "workspace_authorization_denied" } })
})

/**
 * The share path through the shipped app: the mounted route, the composed
 * remote-access service, and this deployment's real SQLite authority. The
 * refusal is the whole point — a denied share must arrive before the service
 * enrolls this machine, so nothing here reaches a relay or a heartbeat.
 */
test("a machine share of a workspace another account holds enrolls nothing", async () => {
  const directory = path.join(root, "their-workspace")
  await fs.mkdir(directory, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { stdio: "ignore" })
  git("init", "-b", "main")
  git("config", "user.email", "stranger@example.test")
  git("config", "user.name", "Stranger")
  await fs.writeFile(path.join(directory, "README.md"), "their workspace")
  git("add", "README.md")
  git("commit", "-m", "their workspace")
  await ensureWorkspace({
    workspaceId: "ws_theirs",
    project_id: "project_theirs",
    org_id: "org_theirs",
    directory,
  })

  // The authority holds it for somebody who is not this deployment's
  // operator. Registered through the authority itself, so the row and its
  // ownership are the real ones the share will read.
  const authority = services.authority!
  await authority.registerLocalForSharing(
    {
      mode: "signed",
      user: {
        subject: "stranger",
        tokenIdentifier: "https://idp.example.test|stranger",
        issuer: "https://idp.example.test",
      },
    } as never,
    { workspaceId: "ws_theirs", projectId: "project_theirs", displayName: "theirs", remoteDirectory: directory },
  )

  const refused = await composed.app.request("http://selfhost.test/api/workspace/ws_theirs/host-assignment", {
    method: "POST",
    headers: { ...operator.headers, "content-type": "application/json" },
    body: JSON.stringify({}),
  })

  expect(refused.status).toBe(404)
  expect(await refused.json()).toMatchObject({ error: { code: "workspace_not_found" } })

  const database = openAuthorityDb()
  try {
    // No enrollment, no serving generation, no assignment: the refusal landed
    // before the service touched the machine.
    expect(database().prepare(`select count(*) as count from host_enrollments`).get()).toEqual({ count: 0 })
    expect(database().prepare(`select count(*) as count from host_workspace_assignments`).get()).toEqual({ count: 0 })
    expect(database().prepare(`select count(*) as count from host_enrollment_requests`).get()).toEqual({ count: 0 })
  } finally {
    database.close()
  }
})
