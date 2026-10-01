import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { realDirectoryPath } from "@claxedo/helpers/real-path"

// A credential change on the signed self-hosted server has to reach the
// embedded workspace runtimes this server hosts, not only its cloud sandboxes:
// a runtime that is never re-applied keeps projecting the previous selection.

let dataDir: string
let previousEnv: Record<string, string | undefined>
let services: Awaited<ReturnType<typeof import("./app").createDefaultLocalControlPlaneServices>>
let composed: ReturnType<typeof import("./app").createSelfHostedApp>
let owner: { id: string; headers: Record<string, string> }
const projections = vi.fn(async () => ({ machineOwnerUserId: "", accounts: {} }))

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-signed-credential-refresh-"))
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
  const embedded = getEmbeddedAuth()
  await embedded.ready
  const res = await embedded.handler(new Request("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "credential-owner@selfhost.test", password: "correct-horse-battery", name: "owner" }),
  }))
  expect(res.status).toBe(200)
  const body = await res.json() as { user: { id: string } }
  owner = { id: body.user.id, headers: { authorization: `Bearer ${res.headers.get("set-auth-token")}` } }
  process.env.CLAXEDO_OPERATOR_SUBJECTS = owner.id
  const { createDefaultLocalControlPlaneServices, createSelfHostedApp, embeddedManagedPrivateSessionPolicy } = await import("./app")
  services = createDefaultLocalControlPlaneServices()
  composed = createSelfHostedApp(services)
  const authority = services.authority
  if (!authority) throw new Error("signed self-hosted services expose a workspace authority")
  const { configureEmbeddedWorkspaceRuntime } = await import("@claxedo/local-server/self-hosted-execution")
  configureEmbeddedWorkspaceRuntime({
    sessionIdWorkspace: () => undefined, sessionAccessPolicy: embeddedManagedPrivateSessionPolicy(authority) })
  const { configureAgentConfig } = await import("@claxedo/server-core/agent-config/index")
  configureAgentConfig({ projectAuth: projections })
})

afterAll(async () => {
  const { configureEmbeddedWorkspaceRuntime, shutdownEmbeddedWorkspaceRuntimes } = await import("@claxedo/local-server/self-hosted-execution")
  await shutdownEmbeddedWorkspaceRuntimes()
  configureEmbeddedWorkspaceRuntime({
    sessionIdWorkspace: () => undefined,})
  const { disposeAgentConfig } = await import("@claxedo/server-core/agent-config/index")
  disposeAgentConfig()
  await composed.dispose()
  services.close()
  const { closeAuthorityDatabases } = await import("@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store")
  closeAuthorityDatabases()
  const { resetEmbeddedAuthForTests } = await import("./embedded-auth")
  resetEmbeddedAuthForTests()
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test("a signed credential change re-applies the embedded workspace runtimes this server hosts", async () => {
  const directory = realDirectoryPath(fs.mkdtempSync(path.join(dataDir, "repo-")))
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory, stdio: "ignore" })
  const created = await composed.app.request("/api/claxedo/projects", {
    method: "POST",
    headers: { ...owner.headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "credential-refresh", source: { kind: "directory", directory } }),
  })
  expect(created.status).toBe(201)
  const { resolveWorkspace } = await import("@claxedo/server-core/workspace/store/index")
  const workspace = await resolveWorkspace({ directory })
  if (!workspace) throw new Error("the signed folder project registered no workspace")
  const { ensureEmbeddedWorkspaceRuntime } = await import("@claxedo/local-server/self-hosted-execution")
  await ensureEmbeddedWorkspaceRuntime(workspace, { config: "sync" })
  projections.mockClear()

  const stored = await composed.app.request("/api/claxedo/credentials", {
    method: "PUT",
    headers: { ...owner.headers, "content-type": "application/json" },
    body: JSON.stringify({ provider_id: "openai", kind: "api_key", source: "managed", label: "OpenAI", secret: "sk-signed-owner" }),
  })
  expect(stored.status, await stored.clone().text()).toBe(200)
  expect(projections).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: workspace.id }))
}, 60_000)
