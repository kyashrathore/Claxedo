import { afterEach, describe, expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import type { ConnectionProvider } from "@claxedo/agent-sdk-runtime"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { configureAgentConfig, disposeAgentConfig, saveUserConfig } from "@claxedo/server-core/agent-config/index"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { putSessionMeta, sessionMeta } from "@claxedo/server-core/session/meta/index"
import { ensureWorkspace } from "@claxedo/server-core/workspace/store/index"
import type { Preset, StartCommand, Task, TaskSessionLink } from "@claxedo/tasks"
import {
  configureEmbeddedWorkspaceRuntime,
  ensureEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
} from "../deployments/local/embedded-workspace-runtime"
import { createLocalTasksSessionBridge } from "./session-bridge"

const CONNECTION_ID = "tasks-fixture"
const MODEL = { providerID: "fixture", modelID: "fixture-large" }

const capabilities = {
  abort: false, reconnect: false, replay: true, permissions: false, questions: false,
  todos: false, commands: false, fork: false, revert: false, unrevert: false,
  configOptions: false, subagents: false,
}

type Created = { id: string; instructions?: string }

function fixtureProvider(input: { offeredModelId: string }) {
  const created: Created[] = []
  const turns: string[] = []
  const provider: ConnectionProvider<Record<string, never>> = {
    providerKey: "tasks-fixture-provider",
    validateConfig: () => ({}),
    project: () => ({ label: "Tasks fixture", readiness: "ready", capabilities }),
    resolve: () => ({ config: {} }),
    createAdapter: () => ({
      sessionConfigOwner: "runtime",
      adapterCapabilities: ["session-instructions"],
      async createSession(_directory, _title, id, options) {
        created.push({ id: id!, ...(options?.instructions ? { instructions: options.instructions } : {}) })
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
        harness: "tasks-fixture",
        modelSelection: {
          status: "optional" as const,
          models: [{ providerId: MODEL.providerID, modelId: input.offeredModelId, name: "Fixture" }],
        },
      }),
      async *executeTurn(binding, prompt) {
        if (prompt.userMessageId) turns.push(prompt.userMessageId)
        yield { type: "text-delta" as const, delta: "ack" }
        yield { type: "finish" as const, sessionId: binding.sessionId }
      },
      dispose() {},
    }),
  }
  return { provider, created, turns }
}

function preset(): Preset {
  return {
    id: "pst_1",
    revision: 3,
    scopeId: "local",
    ownerId: "local",
    name: "Careful review",
    instructions: "Read before you write.",
    execution: { placement: "local", capabilities: { mode: "inherit-local" } },
    configurations: { primary: { harness: { id: CONNECTION_ID, access: "connection" }, model: MODEL, effort: "high" } },
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function task(input: { workspaceId: string | null; projectId?: string }): Task {
  return {
    id: "tsk_1",
    revision: 4,
    scopeId: "local",
    projectId: input.projectId ?? "prj_1",
    workspaceId: input.workspaceId,
    parentTaskId: null,
    title: "Fix the importer",
    description: "The CSV importer drops the last row.",
    status: "todo",
    childSetRevision: 0,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function link(sessionRef: { sessionId: string; workspaceId: string | null }): TaskSessionLink {
  return {
    scopeId: "local",
    taskId: "tsk_1",
    slot: "primary",
    attempt: 1,
    sessionRef,
    continuedFrom: null,
    presetId: "pst_1",
    presetRevision: 3,
    presetNameAtStart: "Careful review",
    createdAt: 1,
  }
}

function startCommand(input: { workspaceId: string | null; projectId?: string; digest: string }): StartCommand {
  return {
    actor: { scopeId: "local", ownerId: "local" },
    task: task(input),
    preset: preset(),
    slot: "primary",
    attempt: 1,
    previewDigest: input.digest,
    handoffText: null,
    continueFromPrevious: false,
    clientRequestId: "req_1",
    previousSession: null,
  }
}

async function waitForMessage(request: (path: string) => Promise<Response>, sessionId: string, messageId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await request(`/session/${sessionId}/message`)
    const text = await response.text()
    if (!text.startsWith("[")) throw new Error(`message read ${response.status}: ${text.slice(0, 200)}`)
    const messages: unknown = JSON.parse(text)
    if (Array.isArray(messages) && messages.some((message) => message?.info?.id === messageId)) return messages
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`no message ${messageId} on ${sessionId}`)
}

async function harness(input: { offeredModelId?: string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tasks-session-bridge-"))
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  // The workspace store refuses to register a local directory that is not a
  // repository, and the bridge resolves its target through that store.
  await promisify(execFile)("git", ["init", "-q"], { cwd: project })
  process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
  const fixture = fixtureProvider({ offeredModelId: input.offeredModelId ?? MODEL.modelID })
  configureEmbeddedWorkspaceRuntime({ connectionProviders: [fixture.provider] })
  configureAgentConfig({ connectionProviders: [fixture.provider] })
  // The bridge dispatches through the local runtime port, and a create there
  // resynchronizes the runtime from the user config first: a connection
  // applied directly to the host would be gone by the time it lands.
  await saveUserConfig({
    version: 3,
    mcp: {},
    connections: {
      [CONNECTION_ID]: {
        connectionId: CONNECTION_ID,
        providerKey: "tasks-fixture-provider",
        configRevision: 1,
        enabled: true,
        config: {},
      },
    },
  })
  const workspace = await ensureWorkspace({ workspaceId: "ws_tasks", directory: project })
  const runtime = await ensureEmbeddedWorkspaceRuntime(workspace!)
  const request = (pathname: string) => Promise.resolve(runtime.app.request(
    `http://runtime.test${pathname}${pathname.includes("?") ? "&" : "?"}directory=${encodeURIComponent(workspace!.directory)}`,
  ))
  return {
    root,
    project,
    workspaceId: workspace!.id,
    projectId: workspace!.project_id ?? workspace!.id,
    bridge: createLocalTasksSessionBridge(),
    request,
    ...fixture,
  }
}

async function registerWorkspace(input: { workspaceId: string; projectId: string }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tasks-session-bridge-sibling-"))
  await promisify(execFile)("git", ["init", "-q"], { cwd: directory })
  await ensureWorkspace({ workspaceId: input.workspaceId, project_id: input.projectId, directory })
  return directory
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

describe("local tasks session bridge", () => {
  test("starts the previewed configuration and admits its first message exactly once", async () => {
    const host = await harness()
    roots.push(host.root)

    const previewed = await host.bridge.preview({
      actor: { scopeId: "local", ownerId: "local" },
      task: task({ workspaceId: host.workspaceId }),
      preset: preset(),
      slot: "primary",
      attempt: 1,
      continueFromPrevious: false,
      currentLink: null,
      currentState: null,
    })
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview).toMatchObject({
      available: true,
      blockers: [],
      placement: "local",
      previousTranscriptReadable: false,
      configuration: { harness: { id: CONNECTION_ID, access: "connection" }, model: MODEL, effort: "high" },
    })

    const command = startCommand({ workspaceId: host.workspaceId, digest: previewed.preview.digest })
    const started = await host.bridge.start(command)
    expect(started).toMatchObject({ ok: true })
    if (!started.ok) return
    const sessionId = started.session.sessionRef.sessionId
    expect(started.session).toMatchObject({ sessionRef: { workspaceId: host.workspaceId }, continuedFrom: null })

    expect(host.created).toEqual([{ id: sessionId, instructions: expect.stringContaining("Read before you write.") }])
    const config: unknown = await (await host.request(`/session/${sessionId}/config`)).json()
    expect(config).toMatchObject({
      instructions: expect.stringContaining("Read before you write."),
      model: MODEL,
      variant: "high",
      harness: { id: CONNECTION_ID, access: "connection" },
    })

    const messageId = host.turns[0] ?? ""
    expect(messageId).toMatch(/^msg_tasks_/)
    const messages = await waitForMessage(host.request, sessionId, messageId)
    expect(JSON.stringify(messages)).toContain("Fix the importer")

    const replayed = await host.bridge.start(command)
    expect(replayed).toMatchObject({ ok: true })
    if (!replayed.ok) return
    expect(replayed.session.sessionRef.sessionId).toBe(sessionId)
    expect(host.created).toHaveLength(1)
    expect(host.turns).toEqual([messageId])
  })

  test("carries the previous session into the instruction block when Continue is chosen", async () => {
    const host = await harness()
    roots.push(host.root)
    const previewCommand = {
      actor: { scopeId: "local", ownerId: "local" },
      task: task({ workspaceId: host.workspaceId }),
      preset: preset(),
      slot: "primary" as const,
      attempt: 1,
      continueFromPrevious: false,
      currentLink: null,
      currentState: null,
    }
    const first = await host.bridge.preview(previewCommand)
    expect(first).toMatchObject({ ok: true })
    if (!first.ok) return
    const started = await host.bridge.start(startCommand({ workspaceId: host.workspaceId, digest: first.preview.digest }))
    expect(started).toMatchObject({ ok: true })
    if (!started.ok) return
    const previous = started.session.sessionRef
    await waitForMessage(host.request, previous.sessionId, host.turns[0] ?? "")

    const continued = await host.bridge.preview({
      ...previewCommand,
      attempt: 2,
      continueFromPrevious: true,
      currentLink: link(previous),
      currentState: "archived",
    })
    expect(continued).toMatchObject({ ok: true })
    if (!continued.ok) return
    expect(continued.preview.previousTranscriptReadable).toBe(true)

    const restarted = await host.bridge.start({
      ...startCommand({ workspaceId: host.workspaceId, digest: continued.preview.digest }),
      attempt: 2,
      continueFromPrevious: true,
      previousSession: previous,
    })
    expect(restarted).toMatchObject({ ok: true })
    if (!restarted.ok) return
    expect(restarted.session.continuedFrom).toEqual(previous)
    expect(restarted.session.sessionRef.sessionId).not.toBe(previous.sessionId)
    expect(host.created[1]?.instructions).toContain("<session-handoff")
    expect(host.created[1]?.instructions).toContain("Fix the importer")
  })

  test("starts a task with no workspace preference in its project's own workspace", async () => {
    const host = await harness()
    roots.push(host.root)
    const previewed = await host.bridge.preview({
      actor: { scopeId: "local", ownerId: "local" },
      task: task({ workspaceId: null, projectId: host.projectId }),
      preset: preset(),
      slot: "primary",
      attempt: 1,
      continueFromPrevious: false,
      currentLink: null,
      currentState: null,
    })
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview.available).toBe(true)

    const started = await host.bridge.start(startCommand({
      workspaceId: null,
      projectId: host.projectId,
      digest: previewed.preview.digest,
    }))
    expect(started).toMatchObject({ ok: true })
    if (!started.ok) return
    expect(started.session.sessionRef.workspaceId).toBe(host.workspaceId)
    expect(host.created).toHaveLength(1)
  })

  test("refuses to guess when a project holds two workspaces and neither is its root", async () => {
    const host = await harness()
    roots.push(host.root)
    roots.push(await registerWorkspace({ workspaceId: "ws_left", projectId: "prj_ambiguous" }))
    roots.push(await registerWorkspace({ workspaceId: "ws_right", projectId: "prj_ambiguous" }))

    const previewed = await host.bridge.preview({
      actor: { scopeId: "local", ownerId: "local" },
      task: task({ workspaceId: null, projectId: "prj_ambiguous" }),
      preset: preset(),
      slot: "primary",
      attempt: 1,
      continueFromPrevious: false,
      currentLink: null,
      currentState: null,
    })
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview.available).toBe(false)
    expect(previewed.preview.blockers).toEqual([{
      code: "source_unavailable",
      detail: expect.stringContaining("prj_ambiguous has 2 workspaces"),
    }])

    const started = await host.bridge.start(startCommand({
      workspaceId: null,
      projectId: "prj_ambiguous",
      digest: previewed.preview.digest,
    }))
    expect(started).toMatchObject({ ok: false, error: { code: "unsupported" } })
    expect(host.created).toEqual([])
  })

  test("refuses a start whose preview digest no longer describes the configuration", async () => {
    const host = await harness()
    roots.push(host.root)
    const refused = await host.bridge.start(startCommand({ workspaceId: host.workspaceId, digest: "stale" }))
    expect(refused).toMatchObject({ ok: false, error: { code: "conflict" } })
    expect(host.created).toEqual([])
  })

  test("blocks a model the registered harness does not offer", async () => {
    const host = await harness({ offeredModelId: "something-else" })
    roots.push(host.root)
    const previewed = await host.bridge.preview({
      actor: { scopeId: "local", ownerId: "local" },
      task: task({ workspaceId: host.workspaceId }),
      preset: preset(),
      slot: "primary",
      attempt: 1,
      continueFromPrevious: false,
      currentLink: null,
      currentState: null,
    })
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview.available).toBe(false)
    expect(previewed.preview.blockers).toEqual([{ code: "model_unavailable", detail: expect.any(String) }])
  })

  test("blocks a cloud preset and never starts one", async () => {
    const host = await harness()
    roots.push(host.root)
    const cloud: Preset = {
      ...preset(),
      execution: { placement: "cloud", capabilities: { mode: "selected", plugins: [], skills: [] } },
    }
    const previewed = await host.bridge.preview({
      actor: { scopeId: "local", ownerId: "local" },
      task: task({ workspaceId: host.workspaceId }),
      preset: cloud,
      slot: "primary",
      attempt: 1,
      continueFromPrevious: false,
      currentLink: null,
      currentState: null,
    })
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview.blockers).toEqual([{ code: "placement_unsupported", detail: expect.any(String) }])

    const started = await host.bridge.start({
      ...startCommand({ workspaceId: host.workspaceId, digest: previewed.preview.digest }),
      preset: cloud,
    })
    expect(started).toMatchObject({ ok: false, error: { code: "unsupported" } })
    expect(host.created).toEqual([])
  })

  test("reads liveness from the projection and the runtime, and stores none of it", async () => {
    const host = await harness()
    roots.push(host.root)
    const previewed = await host.bridge.preview({
      actor: { scopeId: "local", ownerId: "local" },
      task: task({ workspaceId: host.workspaceId }),
      preset: preset(),
      slot: "primary",
      attempt: 1,
      continueFromPrevious: false,
      currentLink: null,
      currentState: null,
    })
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    const started = await host.bridge.start(startCommand({ workspaceId: host.workspaceId, digest: previewed.preview.digest }))
    expect(started).toMatchObject({ ok: true })
    if (!started.ok) return
    const live = started.session.sessionRef

    expect(await sessionMeta(live.sessionId)).toMatchObject({ workspaceID: host.workspaceId })
    expect(await host.bridge.sessionState([live])).toEqual([{ session: live, state: "live" }])

    await putSessionMeta(live.sessionId, { archived: Date.now() })
    expect(await host.bridge.sessionState([live])).toEqual([{ session: live, state: "archived" }])

    const absent = { sessionId: "ses_missing", workspaceId: host.workspaceId }
    expect(await host.bridge.sessionState([absent])).toEqual([{ session: absent, state: "deleted" }])
  })
})
