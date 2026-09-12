/**
 * A session Tasks started, read back by a build that no longer has Tasks.
 *
 * `CLAXEDO_BUILD_TASKS=0` removes the routes, the kit and the composition from
 * the artifact. What it must NOT remove is a user's existing work: the session,
 * its retained instructions and its resolved configuration belong to the
 * session owner, and Tasks only holds a link to them. If any of that had ended
 * up behind the feature, an operator who turned Tasks off would find live
 * sessions unreadable — and every test that boots the enabled composition
 * would still be green.
 *
 * So this creates the session through the real enabled bridge, then reads it
 * back with no Tasks contribution mounted at all.
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import type { ConnectionProvider } from "@claxedo/agent-sdk-runtime"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { configureAgentConfig, disposeAgentConfig, saveUserConfig } from "@claxedo/server-core/agent-config/index"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { ensureWorkspace } from "@claxedo/server-core/workspace/store/index"
import { startConfigurationDigest, type Preset, type Task } from "@claxedo/tasks"
import {
  configureEmbeddedWorkspaceRuntime,
  ensureEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
} from "../deployments/local/embedded-workspace-runtime"
import { createLocalApp, type LocalAppOptions } from "../app/local-app"
import { createLocalTasksSessionBridge } from "./session-bridge"

const CONNECTION_ID = "tasks-off-fixture"
const MODEL = { providerID: "fixture", modelID: "fixture-large" }
const INSTRUCTIONS = "Read before you write."
const LOOPBACK = "http://127.0.0.1:4096"
const TASKS = "/api/claxedo/tasks"

const capabilities = {
  abort: false, reconnect: false, replay: true, permissions: false, questions: false,
  todos: false, commands: false, fork: false, revert: false, unrevert: false,
  configOptions: false, subagents: false,
}

function fixtureProvider() {
  const provider: ConnectionProvider<Record<string, never>> = {
    providerKey: "tasks-off-fixture-provider",
    validateConfig: () => ({}),
    project: () => ({ label: "Tasks off fixture", readiness: "ready", capabilities }),
    resolve: () => ({ config: {} }),
    createAdapter: () => ({
      sessionConfigOwner: "runtime",
      adapterCapabilities: ["session-instructions"],
      async createSession(_directory, _title, id) {
        return { id: id!, agentSessionId: `upstream-${id}` }
      },
      async getSession() { return null },
      async getMessages() { return [] },
      async updateSession() { return null },
      async deleteSession() {},
      async getSessionConfig() { throw new Error("runtime-owned config") },
      async updateSessionConfig() { throw new Error("runtime-owned config") },
      readHarnessCapabilities: () => ({
        ...capabilities,
        goals: false,
        harness: "tasks-off-fixture",
        modelSelection: {
          status: "optional" as const,
          models: [{ providerId: MODEL.providerID, modelId: MODEL.modelID, name: "Fixture" }],
        },
      }),
      async *executeTurn(binding) {
        yield { type: "finish" as const, sessionId: binding.sessionId }
      },
      dispose() {},
    }),
  }
  return provider
}

function preset(): Preset {
  return {
    id: "pst_off",
    revision: 1,
    scopeId: "local",
    ownerId: "local",
    name: "Careful review",
    instructions: INSTRUCTIONS,
    execution: { placement: "local", capabilities: { mode: "inherit-local" } },
    configurations: { primary: { harness: { id: CONNECTION_ID, access: "connection" }, model: MODEL, effort: null } },
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function task(workspaceId: string): Task {
  return {
    id: "tsk_off",
    revision: 1,
    scopeId: "local",
    projectId: "prj_off",
    workspaceId,
    parentTaskId: null,
    title: "Outlives the feature",
    description: "The session must still be readable with Tasks removed.",
    status: "todo",
    childSetRevision: 0,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

/** The services `createLocalApp` needs; none of them is a Tasks dependency. */
function services() {
  return {
    auth: localOnlyAuthAdapter(),
    credentials: {
      listCredentials: async () => [],
      getCredentialByProvider: async () => undefined,
      putCredential: async () => ({ id: "cred_1" }),
      deleteCredential: async () => true,
      deleteCredentialsByProvider: async () => 0,
      updateCredentialStatus: async () => {},
      syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
    },
    localExecution: { enabled: true },
    telemetry: { capture: vi.fn() },
    projectionStore: {
      put_session_meta: vi.fn(async () => {}),
      delete_session_meta: vi.fn(async () => {}),
      list_session_metas: vi.fn(async () => []),
      list_session_navigation_metas: vi.fn(async () => []),
    },
    relay: {},
    sandbox: {},
    durableSessionLog: {},
  } as unknown as LocalAppOptions["services"]
}

const roots: string[] = []

afterEach(async () => {
  await shutdownEmbeddedWorkspaceRuntimes()
  disposeAgentConfig()
  ClaxedoDB.close()
  closeAuthorityDatabases()
  configureEmbeddedWorkspaceRuntime({})
  configureAgentConfig()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
  delete process.env.CLAXEDO_DATA_DIR
})

async function startedSession() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tasks-off-resume-"))
  roots.push(root)
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  // The workspace store refuses to register a local directory that is not a
  // repository, and the bridge resolves its target through that store.
  await promisify(execFile)("git", ["init", "-q"], { cwd: project })
  process.env.CLAXEDO_DATA_DIR = path.join(root, "data")

  const provider = fixtureProvider()
  configureEmbeddedWorkspaceRuntime({ connectionProviders: [provider] })
  configureAgentConfig({ connectionProviders: [provider] })
  await saveUserConfig({
    version: 3,
    mcp: {},
    connections: {
      [CONNECTION_ID]: {
        connectionId: CONNECTION_ID,
        providerKey: "tasks-off-fixture-provider",
        configRevision: 1,
        enabled: true,
        config: {},
      },
    },
  })
  const workspace = await ensureWorkspace({ workspaceId: "ws_tasks_off", directory: project })
  const runtime = await ensureEmbeddedWorkspaceRuntime(workspace!)
  const bridge = createLocalTasksSessionBridge()

  const previewed = await bridge.preview({
    actor: { scopeId: "local", ownerId: "local" },
    task: task(workspace!.id),
    preset: preset(),
    slot: "primary",
    attempt: 1,
    continueFromPrevious: false,
    currentLink: null,
    currentState: null,
  })
  if (!previewed.ok) throw new Error(`preview refused: ${JSON.stringify(previewed)}`)
  const started = await bridge.start({
    actor: { scopeId: "local", ownerId: "local" },
    task: task(workspace!.id),
    preset: preset(),
    slot: "primary",
    attempt: 1,
    previewDigest: previewed.preview.digest,
    continueFromPrevious: false,
    clientRequestId: "req_off",
    configurationDigest: await startConfigurationDigest({ preset: preset(), slot: "primary" }),
    previousSession: null,
  })
  if (!started.ok) throw new Error(`start refused: ${JSON.stringify(started)}`)

  return {
    sessionId: started.session.sessionRef.sessionId,
    runtimeRequest: (pathname: string) =>
      Promise.resolve(
        runtime.app.request(
          `http://runtime.test${pathname}?directory=${encodeURIComponent(workspace!.directory)}`,
        ),
      ),
  }
}

describe("a Tasks-started session with Tasks removed from the build", () => {
  test("its configuration still answers, and the Tasks routes are gone", async () => {
    const session = await startedSession()

    // The off artifact's composition: `claxedo-server-entry.ts` and
    // `self-hosted-node/start.ts` contribute nothing for Tasks, so the app is
    // built with the rest of its contributions and none of these routes.
    const off = createLocalApp({ services: services(), routeContributions: [] }).app
    expect((await off.request(`${LOOPBACK}${TASKS}/capabilities`)).status).toBe(404)
    expect((await off.request(`${LOOPBACK}${TASKS}/tasks?projectId=prj_off`)).status).toBe(404)

    const config = await session.runtimeRequest(`/session/${session.sessionId}/config`)
    expect(config.status).toBe(200)
    expect(await config.json()).toMatchObject({
      instructions: expect.stringContaining(INSTRUCTIONS),
      model: MODEL,
      harness: { id: CONNECTION_ID, access: "connection" },
    })
  })
})
