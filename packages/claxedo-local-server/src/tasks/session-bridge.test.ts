import { afterEach, describe, expect, test, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { NO_HARNESS_EFFORT, type ConnectionProvider, type HarnessEffortLevels } from "@claxedo/agent-sdk-runtime"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { configureAgentConfig, disposeAgentConfig, saveUserConfig } from "@claxedo/server-core/agent-config/index"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { putSessionMeta, sessionMeta } from "@claxedo/server-core/session/meta/index"
import { ensureWorkspace } from "@claxedo/server-core/workspace/store/index"
import { createMemoryTasksStore } from "@claxedo/tasks/test-support"
import {
  TasksError,
  createTasksService,
  startConfigurationDigest,
  type Preset,
  type SessionHandoffCommand,
  type SessionReference,
  type StartCommand,
  type Task,
  type TaskSessionLink,
  type TasksSessionBridgePort,
} from "@claxedo/tasks"
import {
  configureEmbeddedWorkspaceRuntime,
  ensureEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
} from "../deployments/local/embedded-workspace-runtime"
import {
  tasksSessionBridgeConformance,
  type TasksSessionBridgeFixture,
} from "@claxedo/server-core/tasks-host/session-bridge-conformance"
import { createLocalTasksSessionBridge } from "./session-bridge"

const CONNECTION_ID = "tasks-fixture"
const MODEL = { providerID: "fixture", modelID: "fixture-large" }

const capabilities = {
  abort: false, reconnect: false, replay: true, permissions: false, questions: false,
  todos: false, commands: false, fork: false, revert: false, unrevert: false,
  configOptions: false, subagents: false,
}

type Created = { id: string; instructions?: string }

function fixtureProvider(input: { offeredModelId: string; effortLevels?: HarnessEffortLevels }) {
  const created: Created[] = []
  const turns: string[] = []
  const provider: ConnectionProvider<Record<string, never>> = {
    providerKey: "tasks-fixture-provider",
    validateConfig: () => ({}),
    project: () => ({ label: "Tasks fixture", readiness: "ready", capabilities }),
    resolve: () => ({ config: {} }),
    createAdapter: () => ({
      sessionConfigOwner: "runtime",
      instructionChannel: "turn-system-prompt" as const,
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
        effortLevels: NO_HARNESS_EFFORT,
        instructionChannel: "turn-system-prompt" as const,
        modelSelection: {
          status: "optional" as const,
          models: [{ providerId: MODEL.providerID, modelId: input.offeredModelId, name: "Fixture" }],
        },
        ...(input.effortLevels ? { effortLevels: input.effortLevels } : {}),
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
    number: 1,
    workspaceId: input.workspaceId,
    parentTaskId: null,
    createdFrom: null,
    title: "Fix the importer",
    description: "The CSV importer drops the last row.",
    status: "todo",
    childSetRevision: 0,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function link(sessionRef: { sessionId: string; workspaceId: string | null }, configurationDigest: string): TaskSessionLink {
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
    configurationDigest,
    handoffText: null,
    createdAt: 1,
  }
}

async function startCommand(input: {
  workspaceId: string | null
  projectId?: string
  digest: string
  preset?: Preset
}): Promise<StartCommand> {
  const chosen = input.preset ?? preset()
  return {
    actor: { scopeId: "local", ownerId: "local" },
    task: task(input),
    preset: chosen,
    slot: "primary",
    attempt: 1,
    previewDigest: input.digest,
    continueFromPrevious: false,
    clientRequestId: "req_1",
    configurationDigest: await startConfigurationDigest({ preset: chosen, slot: "primary" }),
    previousSession: null,
    authorizeTranscript: async () => true,
  }
}

function handoffCommand(input: {
  workspaceId: string | null
  projectId?: string
  session: SessionReference
  attempt?: number
}): SessionHandoffCommand {
  return {
    actor: { scopeId: "local", ownerId: "local" },
    task: task(input),
    slot: "primary",
    attempt: input.attempt ?? 1,
    handoffText: null,
    session: input.session,
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

async function harness(input: { offeredModelId?: string; effortLevels?: HarnessEffortLevels } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tasks-session-bridge-"))
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  // The workspace store refuses to register a local directory that is not a
  // repository, and the bridge resolves its target through that store.
  await promisify(execFile)("git", ["init", "-q"], { cwd: project })
  process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
  const fixture = fixtureProvider({
    offeredModelId: input.offeredModelId ?? MODEL.modelID,
    ...(input.effortLevels ? { effortLevels: input.effortLevels } : {}),
  })
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

/** The local host's answer to `tasksSessionBridgeConformance`'s fixture contract. */
async function bridgeFixture(input: { offeredModelId?: string }): Promise<TasksSessionBridgeFixture> {
  const host = await harness(input.offeredModelId ? { offeredModelId: input.offeredModelId } : {})
  return {
    bridge: host.bridge,
    actor: { scopeId: "local", ownerId: "local" },
    task: task({ workspaceId: host.workspaceId, projectId: host.projectId }),
    projectWorkspaceId: host.workspaceId,
    preset: preset(),
    creates: () => host.created.length,
    instructionsOf: async (sessionId) => host.created.find((row) => row.id === sessionId)?.instructions,
    // A session this runtime never created: its message read answers 404, which
    // is the same "would not say" the core refuses a handoff on.
    unreadableSession: () => ({ sessionId: "ses_tasks_unknown", workspaceId: host.workspaceId }),
    turns: () => host.turns,
    archive: async (sessionId) => {
      await putSessionMeta(sessionId, { archived: Date.now() })
    },
    // The embedded runtime reads its own store while it shuts down, and that
    // store lives under the root; removal waits for `afterEach`, after shutdown.
    dispose: async () => {
      roots.push(host.root)
    },
  }
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

describe("local tasks session bridge conformance", () => {
  for (const testCase of tasksSessionBridgeConformance(bridgeFixture)) {
    test(testCase.name, testCase.run)
  }
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
      authorizeTranscript: async () => true,
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

    const command = await startCommand({ workspaceId: host.workspaceId, digest: previewed.preview.digest })
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

    // The kit commits the link between the two calls, so the create hands the
    // task to nobody on its own.
    expect(host.turns).toEqual([])
    const handed = await host.bridge.handoff(handoffCommand({ workspaceId: host.workspaceId, session: started.session.sessionRef }))
    expect(handed).toMatchObject({ ok: true, sent: true })

    const messageId = host.turns[0] ?? ""
    expect(messageId).toMatch(/^msg_tasks_/)
    const messages = await waitForMessage(host.request, sessionId, messageId)
    expect(JSON.stringify(messages)).toContain("Fix the importer")

    const replayed = await host.bridge.start(command)
    expect(replayed).toMatchObject({ ok: true })
    if (!replayed.ok) return
    expect(replayed.session.sessionRef.sessionId).toBe(sessionId)
    const rehanded = await host.bridge.handoff(handoffCommand({ workspaceId: host.workspaceId, session: started.session.sessionRef }))
    expect(rehanded).toMatchObject({ ok: true, sent: false })
    expect(host.created).toHaveLength(1)
    expect(host.turns).toEqual([messageId])
  })

  test("a Start retried before the task was handed over creates once and sends the message once", async () => {
    // The kit commits the link between `start` and `handoff`, so a process that
    // died there comes back to a live session with no first message. Repeating
    // `start` must neither create a second session nor send anything, and the
    // handoff that follows has to send the task exactly once.
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
      authorizeTranscript: async () => true,
    })
    if (!previewed.ok) throw new Error("preview refused")
    const command = await startCommand({ workspaceId: host.workspaceId, digest: previewed.preview.digest })

    const started = await host.bridge.start(command)
    if (!started.ok) throw new Error("start refused")
    const retried = await host.bridge.start(command)
    if (!retried.ok) throw new Error("retried start refused")
    expect(retried.session.sessionRef).toEqual(started.session.sessionRef)
    expect(host.created).toHaveLength(1)
    expect(host.turns).toEqual([])

    const handed = await host.bridge.handoff(
      handoffCommand({ workspaceId: host.workspaceId, session: retried.session.sessionRef }),
    )
    expect(handed).toMatchObject({ ok: true, sent: true })
    const messageId = host.turns[0] ?? ""
    const messages = await waitForMessage(host.request, retried.session.sessionRef.sessionId, messageId)
    expect(JSON.stringify(messages)).toContain("Fix the importer")
    expect(host.turns).toEqual([messageId])
  })

  test("serializes two starts on one origin, so the second cannot create over the first configuration", async () => {
    // Both requests resolve the same session id from the origin, and this host
    // has no reservation table to collide in: without the in-process lock they
    // both read the id as absent and create it.
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
      authorizeTranscript: async () => true,
    }
    const rewritten: Preset = { ...preset(), revision: 4, instructions: "Ignore the code and rewrite it." }
    const first = await host.bridge.preview(previewCommand)
    const second = await host.bridge.preview({ ...previewCommand, preset: rewritten })
    if (!first.ok || !second.ok) throw new Error("preview refused")
    const firstCommand = await startCommand({ workspaceId: host.workspaceId, digest: first.preview.digest })
    const secondCommand = await startCommand({
      workspaceId: host.workspaceId,
      digest: second.preview.digest,
      preset: rewritten,
    })

    const [one, two] = await Promise.all([host.bridge.start(firstCommand), host.bridge.start(secondCommand)])

    // Which request reaches the lock first is not this host's promise; that
    // only one of them creates, and that the session it created runs its own
    // configuration, is.
    const started = [one, two].filter((outcome) => outcome.ok)
    expect(started).toHaveLength(1)
    expect([one, two].filter((outcome) => !outcome.ok)).toMatchObject([{ error: { code: "conflict" } }])
    expect(host.created).toHaveLength(1)
    const winner = started.at(0)
    if (!winner?.ok) return
    const [ran, lost] = one.ok
      ? ["Read before you write.", "Ignore the code and rewrite it."]
      : ["Ignore the code and rewrite it.", "Read before you write."]
    const config: unknown = await (await host.request(`/session/${winner.session.sessionRef.sessionId}/config`)).json()
    expect(config).toMatchObject({ instructions: expect.stringContaining(ran) })
    expect(JSON.stringify(config)).not.toContain(lost)
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
      authorizeTranscript: async () => true,
    }
    const first = await host.bridge.preview(previewCommand)
    expect(first).toMatchObject({ ok: true })
    if (!first.ok) return
    const started = await host.bridge.start(await startCommand({ workspaceId: host.workspaceId, digest: first.preview.digest }))
    expect(started).toMatchObject({ ok: true })
    if (!started.ok) return
    const previous = started.session.sessionRef
    expect(await host.bridge.handoff(handoffCommand({ workspaceId: host.workspaceId, session: previous }))).toMatchObject({
      ok: true,
      sent: true,
    })
    await waitForMessage(host.request, previous.sessionId, host.turns[0] ?? "")

    const continued = await host.bridge.preview({
      ...previewCommand,
      attempt: 2,
      continueFromPrevious: true,
      currentLink: link(previous, await startConfigurationDigest({ preset: preset(), slot: "primary" })),
      currentState: "archived",
      authorizeTranscript: async () => true,
    })
    expect(continued).toMatchObject({ ok: true })
    if (!continued.ok) return
    expect(continued.preview.previousTranscriptReadable).toBe(true)

    const restarted = await host.bridge.start({
      ...(await startCommand({ workspaceId: host.workspaceId, digest: continued.preview.digest })),
      attempt: 2,
      continueFromPrevious: true,
      previousSession: previous,
      authorizeTranscript: async () => true,
    })
    expect(restarted).toMatchObject({ ok: true })
    if (!restarted.ok) return
    expect(restarted.session.continuedFrom).toEqual(previous)
    expect(restarted.session.sessionRef.sessionId).not.toBe(previous.sessionId)
    expect(host.created[1]?.instructions).toContain("<session-handoff")
    expect(host.created[1]?.instructions).toContain("Fix the importer")
  })

  test("reports the previous transcript as readable before Continue is chosen, and carries it only once it is", async () => {
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
      authorizeTranscript: async () => true,
    }
    const first = await host.bridge.preview(previewCommand)
    if (!first.ok) throw new Error("preview refused")
    const started = await host.bridge.start(await startCommand({ workspaceId: host.workspaceId, digest: first.preview.digest }))
    if (!started.ok) throw new Error("start refused")
    const previous = started.session.sessionRef
    await host.bridge.handoff(handoffCommand({ workspaceId: host.workspaceId, session: previous }))
    await waitForMessage(host.request, previous.sessionId, host.turns[0] ?? "")

    const unchecked = await host.bridge.preview({
      ...previewCommand,
      attempt: 2,
      continueFromPrevious: false,
      currentLink: link(previous, await startConfigurationDigest({ preset: preset(), slot: "primary" })),
      currentState: "archived",
      authorizeTranscript: async () => true,
    })
    expect(unchecked).toMatchObject({ ok: true })
    if (!unchecked.ok) return
    expect(unchecked.preview.previousTranscriptReadable).toBe(true)

    const restarted = await host.bridge.start({
      ...(await startCommand({ workspaceId: host.workspaceId, digest: unchecked.preview.digest })),
      attempt: 2,
      continueFromPrevious: false,
      previousSession: null,
      authorizeTranscript: async () => true,
    })
    expect(restarted).toMatchObject({ ok: true })
    expect(host.created).toHaveLength(2)
    expect(host.created[1]?.instructions).not.toContain("<session-handoff")
  })

  test("offers no transcript from a session the kit reports deleted, even while the runtime still holds it", async () => {
    // A deleted session is the one state the kit does not ask its session
    // authority about, because nothing can be opened or continued from it. Its
    // transcript must therefore not be read here either.
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
      authorizeTranscript: async () => true,
    }
    const first = await host.bridge.preview(previewCommand)
    if (!first.ok) throw new Error("preview refused")
    const started = await host.bridge.start(await startCommand({ workspaceId: host.workspaceId, digest: first.preview.digest }))
    if (!started.ok) throw new Error("start refused")
    const previous = started.session.sessionRef
    await host.bridge.handoff(handoffCommand({ workspaceId: host.workspaceId, session: previous }))
    await waitForMessage(host.request, previous.sessionId, host.turns[0] ?? "")

    const digest = await startConfigurationDigest({ preset: preset(), slot: "primary" })
    const gone = await host.bridge.preview({
      ...previewCommand,
      attempt: 2,
      continueFromPrevious: true,
      currentLink: link(previous, digest),
      currentState: "deleted",
      authorizeTranscript: async () => true,
    })
    expect(gone).toMatchObject({ ok: true })
    if (!gone.ok) return
    expect(gone.preview.previousTranscriptReadable).toBe(false)

    const readable = await host.bridge.preview({
      ...previewCommand,
      attempt: 2,
      continueFromPrevious: true,
      currentLink: link(previous, digest),
      currentState: "archived",
      authorizeTranscript: async () => true,
    })
    expect(readable).toMatchObject({ ok: true })
    if (!readable.ok) return
    expect(readable.preview.previousTranscriptReadable).toBe(true)
  })

  test("reserves the origin and the configuration before the create when a signed host supplies one", async () => {
    const host = await harness()
    roots.push(host.root)
    const createdWhenReserved: number[] = []
    const reserve = vi.fn(async () => {
      createdWhenReserved.push(host.created.length)
      return { ok: true as const, headers: {} }
    })
    const signed = createLocalTasksSessionBridge({ reserve })
    const previewed = await signed.preview({
      actor: { scopeId: "local", ownerId: "local" },
      task: task({ workspaceId: host.workspaceId }),
      preset: preset(),
      slot: "primary",
      attempt: 1,
      continueFromPrevious: false,
      currentLink: null,
      currentState: null,
      authorizeTranscript: async () => true,
    })
    if (!previewed.ok) throw new Error("preview refused")

    const started = await signed.start(await startCommand({ workspaceId: host.workspaceId, digest: previewed.preview.digest }))
    expect(started).toMatchObject({ ok: true })
    if (!started.ok) return
    expect(reserve).toHaveBeenCalledWith({
      actor: { scopeId: "local", ownerId: "local" },
      operationId: `tasks.v1:local:tsk_1:primary:1:${await startConfigurationDigest({ preset: preset(), slot: "primary" })}`,
      sessionId: started.session.sessionRef.sessionId,
      workspaceId: host.workspaceId,
      title: "Fix the importer",
    })
    expect(createdWhenReserved).toEqual([0])
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
      authorizeTranscript: async () => true,
    })
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview.available).toBe(false)
    expect(previewed.preview.blockers).toEqual([{
      code: "source_unavailable",
      detail: expect.stringContaining("prj_ambiguous has 2 workspaces"),
    }])

    const started = await host.bridge.start(await startCommand({
      workspaceId: null,
      projectId: "prj_ambiguous",
      digest: previewed.preview.digest,
    }))
    expect(started).toMatchObject({ ok: false, error: { code: "unsupported" } })
    expect(host.created).toEqual([])
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
      authorizeTranscript: async () => true,
    })
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview.blockers).toEqual([{ code: "placement_unsupported", detail: expect.any(String) }])

    const started = await host.bridge.start({
      ...(await startCommand({ workspaceId: host.workspaceId, digest: previewed.preview.digest })),
      preset: cloud,
    })
    expect(started).toMatchObject({ ok: false, error: { code: "unsupported" } })
    expect(host.created).toEqual([])
  })

  test("refuses the preview and reads nothing when the transcript grant is gone by the time it would read", async () => {
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
      authorizeTranscript: async () => true,
    }
    const first = await host.bridge.preview(previewCommand)
    if (!first.ok) throw new Error("preview refused")
    const started = await host.bridge.start(await startCommand({ workspaceId: host.workspaceId, digest: first.preview.digest }))
    if (!started.ok) throw new Error("start refused")
    const previous = started.session.sessionRef
    await host.bridge.handoff(handoffCommand({ workspaceId: host.workspaceId, session: previous }))
    await waitForMessage(host.request, previous.sessionId, host.turns[0] ?? "")

    const digest = await startConfigurationDigest({ preset: preset(), slot: "primary" })
    const continuing = {
      ...previewCommand,
      attempt: 2,
      continueFromPrevious: true,
      currentLink: link(previous, digest),
      currentState: "archived" as const,
    }

    const refused = await host.bridge.preview({ ...continuing, authorizeTranscript: async () => false })
    expect(refused).toMatchObject({ ok: false, error: { code: "forbidden" } })

    // The same request with the grant still held is the one that reads, so the
    // refusal above is the grant and not the shape of the request.
    const allowed = await host.bridge.preview({ ...continuing, authorizeTranscript: async () => true })
    expect(allowed).toMatchObject({ ok: true })
    if (!allowed.ok) return
    expect(allowed.preview.previousTranscriptReadable).toBe(true)

    const startRefused = await host.bridge.start({
      ...(await startCommand({ workspaceId: host.workspaceId, digest: allowed.preview.digest })),
      attempt: 2,
      continueFromPrevious: true,
      previousSession: previous,
      authorizeTranscript: async () => false,
    })
    expect(startRefused).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(host.created).toHaveLength(1)
  })

  test("keeps a session this origin already handed the task to, rather than abandoning it", async () => {
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
      authorizeTranscript: async () => true,
    })
    if (!previewed.ok) throw new Error("preview refused")
    const command = await startCommand({ workspaceId: host.workspaceId, digest: previewed.preview.digest })
    const started = await host.bridge.start(command)
    if (!started.ok) throw new Error("start refused")
    const session = started.session.sessionRef
    await host.bridge.handoff(handoffCommand({ workspaceId: host.workspaceId, session }))
    await waitForMessage(host.request, session.sessionId, host.turns[0] ?? "")

    const kept = await host.bridge.abandon({
      actor: { scopeId: "local", ownerId: "local" },
      task: task({ workspaceId: host.workspaceId }),
      slot: "primary",
      attempt: 1,
      configurationDigest: command.configurationDigest,
      sessionRef: session,
    })
    expect(kept).toMatchObject({ ok: true, removed: false })
    expect((await host.request(`/session/${session.sessionId}`)).status).toBe(200)
  })

  test("a preset changed while the session was being created leaves the origin free for the next Start", async () => {
    const host = await harness()
    roots.push(host.root)

    const actor = { scopeId: "local", ownerId: "local" }
    const store = createMemoryTasksStore()
    await store.presets.insert(preset())
    let minted = 0
    let ticks = 1_000

    // The edit lands between the create and the settlement, which is the race
    // the settlement's preset assertion refuses.
    let edited = false
    const racing: TasksSessionBridgePort = {
      ...host.bridge,
      start: async (command) => {
        if (!edited) {
          edited = true
          await store.presets.update({ ...preset(), revision: 4, instructions: "Ignore the code and rewrite it." }, 3)
        }
        return host.bridge.start(command)
      },
    }
    const service = createTasksService({
      store,
      clock: { now: () => (ticks += 1) },
      ids: { presetId: () => `pst_${(minted += 1)}`, taskId: () => `tsk_${(minted += 1)}` },
      authorization: { authorizeProject: async () => true, authorizeSessionOpen: async () => true },
      bridge: racing,
    })

    const created = (await service.create(actor, {
      projectId: host.projectId,
      title: "Fix the importer",
      description: "The CSV importer drops the last row.",
      workspaceId: host.workspaceId,
      parentTaskId: null,
    })).task

    const request = async (presetRevision: number) => {
      const stored = await store.tasks.get(actor.scopeId, created.id)
      const subject = {
        taskRevision: stored?.revision ?? 0,
        presetId: "pst_1",
        presetRevision,
        slot: "primary" as const,
        attempt: 1,
        continueFromPrevious: false,
      }
      const previewed = await service.startPreview(actor, created.id, subject)
      return { ...subject, clientRequestId: `req_${presetRevision}`, previewDigest: previewed.digest, handoffText: null }
    }

    const refused = await service.start(actor, created.id, await request(3)).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(refused).toBeInstanceOf(TasksError)
    expect(refused instanceof TasksError ? refused.detail.code : "").toBe("conflict")
    expect(await store.links.listByTask(actor.scopeId, created.id)).toHaveLength(0)

    // The session that create made is gone again, together with the row the
    // session lists read it from, so nothing is left holding the origin.
    const sessionId = host.created[0]?.id ?? ""
    expect(host.created).toHaveLength(1)
    expect((await host.request(`/session/${sessionId}`)).status).toBe(404)
    expect(await sessionMeta(sessionId)).toBeUndefined()
    expect(host.turns).toEqual([])

    const retried = await service.start(actor, created.id, await request(4))
    expect(retried).toMatchObject({ created: true, link: { attempt: 1, presetRevision: 4, handoff: "sent" } })
    expect(retried.link.sessionRef.sessionId).toBe(sessionId)
    expect(host.created).toHaveLength(2)
    expect(host.created[1]).toMatchObject({ id: sessionId, instructions: expect.stringContaining("Ignore the code and rewrite it.") })
    expect(await store.links.listByTask(actor.scopeId, created.id)).toHaveLength(1)
    expect(host.turns).toHaveLength(1)
    await waitForMessage(host.request, sessionId, host.turns[0] ?? "")
  })

  test("the session retains the whole resolved group, not just the slot it started under", async () => {
    const host = await harness()
    roots.push(host.root)
    const grouped: Preset = {
      ...preset(),
      configurations: {
        primary: { harness: { id: CONNECTION_ID, access: "connection" }, model: MODEL, effort: "high" },
        review: { harness: { id: CONNECTION_ID, access: "connection" }, model: MODEL, effort: null },
      },
    }

    const previewed = await host.bridge.preview({
      actor: { scopeId: "local", ownerId: "local" },
      task: task({ workspaceId: host.workspaceId }),
      preset: grouped,
      slot: "primary",
      attempt: 1,
      continueFromPrevious: false,
      currentLink: null,
      currentState: null,
      authorizeTranscript: async () => true,
    })
    if (!previewed.ok) throw new Error("preview refused")
    const started = await host.bridge.start(
      await startCommand({ workspaceId: host.workspaceId, digest: previewed.preview.digest, preset: grouped }),
    )
    if (!started.ok) throw new Error("start refused")

    const config: unknown = await (await host.request(`/session/${started.session.sessionRef.sessionId}/config`)).json()
    expect(config).toMatchObject({
      variant: "high",
      group: {
        primary: { harness: { id: CONNECTION_ID, access: "connection" }, model: MODEL, effort: "high" },
        review: { harness: { id: CONNECTION_ID, access: "connection" }, model: MODEL },
      },
    })
    // A slot the preset never configured is absent rather than present and empty.
    expect(Object.keys((config as { group: Record<string, unknown> }).group).sort()).toEqual(["primary", "review"])
    expect((config as { group: { review: Record<string, unknown> } }).group.review.effort).toBeUndefined()
  })

  test("an effort the harness refuses for that model blocks the preview and names the levels it takes", async () => {
    const host = await harness({
      effortLevels: { status: "resolved", models: [{ modelID: MODEL.modelID, levels: ["low", "medium"] }] },
    })
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
      authorizeTranscript: async () => true,
    })
    if (!previewed.ok) throw new Error("preview refused")
    expect(previewed.preview.available).toBe(false)
    expect(previewed.preview.blockers).toMatchObject([{ code: "effort_unsupported" }])
    expect(previewed.preview.blockers[0]?.detail).toContain("low, medium")
    expect(previewed.preview.blockers[0]?.detail).toContain("high")

    const refused = await host.bridge.start(
      await startCommand({ workspaceId: host.workspaceId, digest: previewed.preview.digest }),
    )
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "unsupported", message: expect.stringContaining("it accepts low, medium") },
    })
    expect(host.created).toEqual([])
  })

  test("a catalog that accepts the effort, and one that has not answered, both start", async () => {
    for (const effortLevels of [
      { status: "resolved", models: [{ modelID: MODEL.modelID, levels: ["low", "high"] }] },
      { status: "unresolved", models: [] },
      { status: "unsupported", models: [] },
    ] as const) {
      const host = await harness({ effortLevels })
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
        authorizeTranscript: async () => true,
      })
      if (!previewed.ok) throw new Error(`preview refused for ${effortLevels.status}`)
      expect(previewed.preview, effortLevels.status).toMatchObject({ available: true, blockers: [] })
      await shutdownEmbeddedWorkspaceRuntimes()
      disposeAgentConfig()
      ClaxedoDB.close()
      closeAuthorityDatabases()
    }
  })
})
