import { beforeEach, describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import { D1SessionAuthorityError } from "../authority/adapters/d1/session-authority"
import {
  startConfigurationDigest,
  type ConfigurationSlot,
  type Preset,
  type SessionHandoffCommand,
  type SessionReference,
  type StartCommand,
  type Task,
} from "@claxedo/tasks"
import {
  tasksSessionBridgeConformance,
  type TasksSessionBridgeFixture,
} from "@claxedo/server-core/tasks-host/session-bridge-conformance"
import { createHostedTasksSessionBridge, type HostedTasksSessionBridgeInput } from "./session-bridge"
import type { ControlPlaneServices } from "../authority/services"

const mock = vi.hoisted(() => {
  const workspace = { id: "ws_cloud", kind: "cloud", directory: "/workspace", org_id: "org", project_id: "prj_1" }
  return { workspace, workspaces: [workspace], request: vi.fn() }
})
vi.mock("@claxedo/server-core/workspace/store/index", () => ({
  resolveWorkspace: async ({ workspaceId }: { workspaceId: string }) =>
    workspaceId === "ws_cloud" ? mock.workspace : undefined,
  listWorkspaces: async () => mock.workspaces,
}))
vi.mock("@claxedo/server-core/workspace/http/workspace-runtime-client", () => ({
  createWorkspaceRuntimeClient: () => ({ request: mock.request }),
}))

const HARNESS = { id: "codex", access: "native" as const }
const MODEL = { providerID: "openai", modelID: "gpt-5" }

type RuntimeCall = { path: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }

function runtime(input: { refuseDelete?: boolean; offeredModelId?: string } = {}) {
  const calls: RuntimeCall[] = []
  const sessions = new Map<string, { instructions?: string; variant?: string; messages: Array<{ info: { id: string; role: string; sessionID: string }; parts: unknown[] }> }>()
  mock.request.mockImplementation(async (path: string, init?: RuntimeCall["init"]) => {
    calls.push({ path, ...(init ? { init } : {}) })
    if (path.startsWith("/session/capabilities")) {
      return Response.json({ harness: "codex", modelSelection: { status: "optional", models: [{ providerId: MODEL.providerID, modelId: input.offeredModelId ?? MODEL.modelID, name: "GPT-5" }] } })
    }
    if (path.startsWith("/session?")) {
      const body: unknown = JSON.parse(init?.body ?? "{}")
      const row = typeof body === "object" && body ? (body as Record<string, unknown>) : {}
      const id = String(row.id)
      sessions.set(id, {
        ...(typeof row.instructions === "string" ? { instructions: row.instructions } : {}),
        ...(typeof row.variant === "string" ? { variant: row.variant } : {}),
        messages: [],
      })
      return Response.json({ id, directory: "/workspace", title: row.title }, { status: 201 })
    }
    const message = /^\/session\/([^/]+)\/message$/.exec(path)
    if (message) {
      const session = sessions.get(message[1])
      return session ? Response.json(session.messages) : Response.json({ error: { code: "not_found" } }, { status: 404 })
    }
    const prompt = /^\/session\/([^/]+)\/prompt_async$/.exec(path)
    if (prompt) {
      const session = sessions.get(prompt[1])
      if (!session) return Response.json({ error: { code: "not_found" } }, { status: 404 })
      const body: unknown = JSON.parse(init?.body ?? "{}")
      const row = typeof body === "object" && body ? (body as Record<string, unknown>) : {}
      const messageID = String(row.messageID)
      const parts = Array.isArray(row.parts) ? row.parts : []
      // Parts carry their own identity on the wire, and the bridge filters the
      // page through the contract's own guard: a part without one is not a
      // message, and the replay read would miss it.
      session.messages.push({
        info: { id: messageID, role: "user", sessionID: prompt[1] },
        parts: parts.map((part, index) => ({
          ...(typeof part === "object" && part ? part : {}),
          id: `prt_${messageID}_${index}`,
          sessionID: prompt[1],
          messageID,
        })),
      })
      return new Response(null, { status: 204 })
    }
    const config = /^\/session\/([^/]+)\/config$/.exec(path)
    if (config) {
      const session = sessions.get(config[1])
      if (!session) return Response.json({ error: { code: "not_found" } }, { status: 404 })
      return Response.json({
        harness: HARNESS,
        model: MODEL,
        variant: session.variant ?? null,
        instructions: session.instructions ?? "",
      })
    }
    const read = /^\/session\/([^/]+)$/.exec(path)
    if (read) {
      const session = sessions.get(read[1])
      if (!session) return Response.json({ error: { code: "not_found" } }, { status: 404 })
      if (init?.method !== "DELETE") return Response.json({ id: read[1], directory: "/workspace" })
      if (input.refuseDelete) {
        return Response.json({ error: { message: "this session cannot be deleted" } }, { status: 409 })
      }
      sessions.delete(read[1])
      return Response.json({ ok: true })
    }
    return Response.json({ error: { code: "unexpected", message: path } }, { status: 500 })
  })
  return { calls, sessions }
}

function services(input: { meta?: Map<string, { workspaceID?: string; archived?: number }> } = {}) {
  const metas = input.meta ?? new Map<string, { workspaceID?: string; archived?: number }>()
  // The reservation table keys one operation per origin and holds session_id
  // unique, so a second operation claiming a reserved session is a 409 here
  // exactly as it is in D1.
  const reserved = new Map<string, string>()
  const compensated = (state: "compensation_pending" | "compensated") =>
    vi.fn(async (input: { operationId: string; sessionId: string; workspaceId: string }) => {
      if (state === "compensated") reserved.delete(input.sessionId)
      return { ...input, changed: true, state }
    })
  const authority = {
    reserveRuntimeSession: vi.fn(async (_principal: unknown, intent: { operationId: string; sessionId: string; workspaceId: string }) => {
      const holder = reserved.get(intent.sessionId)
      if (holder && holder !== intent.operationId) {
        throw new D1SessionAuthorityError("resource_conflict", "Session reservation collided or authority changed")
      }
      reserved.set(intent.sessionId, intent.operationId)
      return { ...intent, changed: !holder, state: "reserved" as const }
    }),
    beginSessionCompensation: compensated("compensation_pending"),
    completeSessionCompensation: compensated("compensated"),
  }
  const projectionStore = {
    session_metas: vi.fn(async (ids: string[]) => new Map([...metas].filter(([id]) => ids.includes(id)))),
    put_session_meta: vi.fn(async (sessionId: string, row: { workspaceID?: string; archived?: number }) => {
      metas.set(sessionId, { ...metas.get(sessionId), ...row })
    }),
    delete_session_meta: vi.fn(async (sessionId: string) => {
      metas.delete(sessionId)
    }),
  }
  return {
    authority,
    projectionStore,
    metas,
    // No sandbox manager, which is the deployment the cloud-placement case
    // below is about: one with no isolated root to allocate.
    value: { authority, projectionStore, sandbox: {} } as unknown as ControlPlaneServices,
  }
}

function preset(): Preset {
  return {
    id: "pst_1",
    revision: 2,
    scopeId: "org",
    ownerId: "owner",
    name: "Careful review",
    instructions: "Read before you write.",
    execution: { placement: "local", capabilities: { mode: "inherit-local" } },
    configurations: { primary: { harness: HARNESS, model: MODEL, effort: "high" } },
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function task(): Task {
  return {
    id: "tsk_1",
    revision: 5,
    scopeId: "org",
    projectId: "prj_1",
    number: 1,
    workspaceId: "ws_cloud",
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

const actor = { scopeId: "org", ownerId: "owner" }
const slot: ConfigurationSlot = "primary"

function previewCommand() {
  return {
    actor,
    task: task(),
    preset: preset(),
    slot,
    attempt: 1,
    continueFromPrevious: false,
    currentLink: null,
    currentState: null,
    authorizeTranscript: async () => true,
  }
}

async function startCommand(digest: string, chosen: Preset = preset()): Promise<StartCommand> {
  return {
    actor,
    task: task(),
    preset: chosen,
    slot,
    attempt: 1,
    previewDigest: digest,
    continueFromPrevious: false,
    clientRequestId: "req_1",
    configurationDigest: await startConfigurationDigest({ preset: chosen, slot }),
    previousSession: null,
    authorizeTranscript: async () => true,
  }
}

function handoffCommand(session: SessionReference): SessionHandoffCommand {
  return {
    actor,
    task: task(),
    slot,
    attempt: 1,
    handoffText: "Pick up from the failing import test.",
    session,
  }
}

/** The origin and the configuration digest, which is what this host reserves. */
async function operationIdOf(chosen: Preset = preset()): Promise<string> {
  return `tasks.v1:org:tsk_1:primary:1:${await startConfigurationDigest({ preset: chosen, slot })}`
}

function bridge(
  input: ReturnType<typeof services>,
  principal?: HostedTasksSessionBridgeInput["principal"],
) {
  return createHostedTasksSessionBridge({
    services: input.value,
    runtimeClient: {},
    ...(principal ? { principal } : {}),
  })
}

/** The hosted host's answer to `tasksSessionBridgeConformance`'s fixture contract. */
async function bridgeFixture(input: { offeredModelId?: string }): Promise<TasksSessionBridgeFixture> {
  const host = runtime(input.offeredModelId ? { offeredModelId: input.offeredModelId } : {})
  const composition = services()
  return {
    bridge: bridge(composition),
    actor,
    task: task(),
    projectWorkspaceId: mock.workspace.id,
    preset: preset(),
    creates: () => host.calls.filter((call) => call.path.startsWith("/session?")).length,
    instructionsOf: async (sessionId) => host.sessions.get(sessionId)?.instructions,
    // A session this runtime never created: its message read answers 404, which
    // is the same "would not say" the core refuses a handoff on.
    unreadableSession: () => ({ sessionId: "ses_never_created_here", workspaceId: mock.workspace.id }),
    turns: () => host.calls.filter((call) => call.path.endsWith("/prompt_async")).map((call) => call.path),
    archive: async (sessionId) => {
      composition.metas.set(sessionId, { ...composition.metas.get(sessionId), archived: Date.now() })
    },
    dispose: async () => {
      vi.clearAllMocks()
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("hosted tasks session bridge conformance", () => {
  for (const testCase of tasksSessionBridgeConformance(bridgeFixture)) {
    test(testCase.name, testCase.run)
  }
})

describe("hosted tasks session bridge", () => {
  test("reserves the origin, creates with the resolved configuration, and hands the task over once", async () => {
    const host = runtime()
    const composition = services()
    const kit = bridge(composition)

    const previewed = await kit.preview(previewCommand())
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview).toMatchObject({ available: true, blockers: [], configuration: { model: MODEL, effort: "high" } })

    const started = await kit.start(await startCommand(previewed.preview.digest))
    expect(started).toMatchObject({ ok: true })
    if (!started.ok) return
    const sessionId = started.session.sessionRef.sessionId

    // No resolver: an unsigned host with no canonical human actor still reserves.
    expect(composition.authority.reserveRuntimeSession).toHaveBeenCalledWith(
      { principalKind: "service", actorId: "control-plane", actorKind: "agent" },
      { operationId: await operationIdOf(), sessionId, workspaceId: "ws_cloud", kind: "create", title: "Fix the importer" },
    )

    const create = host.calls.find((call) => call.path.startsWith("/session?"))
    expect(create?.path).toBe("/session?nativeHarness=codex")
    expect(create?.init?.headers?.["x-claxedo-session-registration-operation"]).toBe(await operationIdOf())
    const body: unknown = JSON.parse(create?.init?.body ?? "{}")
    expect(body).toMatchObject({
      id: sessionId,
      title: "Fix the importer",
      model: MODEL,
      variant: "high",
      instructions: expect.stringContaining("Read before you write."),
    })

    // The create hands the task to nobody: the kit commits the link first and
    // asks for the handoff afterwards.
    expect(host.calls.some((call) => call.path.endsWith("/prompt_async"))).toBe(false)
    expect(await kit.handoff(handoffCommand(started.session.sessionRef))).toMatchObject({ ok: true, sent: true })

    const prompt = host.calls.find((call) => call.path.endsWith("/prompt_async"))
    const promptBody: unknown = JSON.parse(prompt?.init?.body ?? "{}")
    expect(promptBody).toMatchObject({
      messageID: expect.stringMatching(/^msg_tasks_/),
      parts: [{ type: "text", text: expect.stringContaining("Pick up from the failing import test.") }],
    })
    expect(composition.projectionStore.put_session_meta).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ workspaceID: "ws_cloud", host: "workspace", model: MODEL }),
    )
  })

  test("reserves for the signed caller's own actor, so the person who started the session can open it", async () => {
    runtime()
    const composition = services()
    const kit = bridge(composition, async (actor) => ({
      principalKind: "user",
      actorId: `act_${actor.ownerId}`,
      actorKind: "human",
    }))
    const previewed = await kit.preview(previewCommand())
    if (!previewed.ok) throw new Error("preview refused")
    expect(await kit.start(await startCommand(previewed.preview.digest))).toMatchObject({ ok: true })

    expect(composition.authority.reserveRuntimeSession).toHaveBeenCalledWith(
      { principalKind: "user", actorId: "act_owner", actorKind: "human" },
      expect.objectContaining({ operationId: await operationIdOf() }),
    )
  })



  test("refuses rather than resending the first message when the message history cannot be read", async () => {
    const host = runtime()
    const composition = services()
    const kit = bridge(composition)
    const previewed = await kit.preview(previewCommand())
    if (!previewed.ok) throw new Error("preview refused")
    const started = await kit.start(await startCommand(previewed.preview.digest))
    expect(started).toMatchObject({ ok: true })
    if (!started.ok) return
    expect(await kit.handoff(handoffCommand(started.session.sessionRef))).toMatchObject({ ok: true, sent: true })

    const readable = mock.request.getMockImplementation()!
    mock.request.mockImplementation(async (path: string, init?: RuntimeCall["init"]) =>
      path.endsWith("/message")
        ? Response.json({ error: { message: "the runtime is restarting" } }, { status: 503 })
        : readable(path, init))

    const refused = await kit.handoff(handoffCommand(started.session.sessionRef))
    expect(refused).toMatchObject({ ok: false, error: { code: "conflict" } })
    expect(host.calls.filter((call) => call.path.endsWith("/prompt_async"))).toHaveLength(1)
  })

  test("compares the configuration of a session another creator won between the probe and the create", async () => {
    const host = runtime()
    const composition = services()
    const kit = bridge(composition)
    const previewed = await kit.preview(previewCommand())
    if (!previewed.ok) throw new Error("preview refused")

    // This Start read the id as absent and the runtime then refused its create:
    // the session under that id belongs to whoever won it, and adopting it
    // without comparing the configuration would report the wrong preset as the
    // one running.
    const answering = mock.request.getMockImplementation()!
    mock.request.mockImplementation(async (path: string, init?: RuntimeCall["init"]) => {
      if (!path.startsWith("/session?")) return answering(path, init)
      const body: unknown = JSON.parse(init?.body ?? "{}")
      const row = typeof body === "object" && body ? (body as Record<string, unknown>) : {}
      await answering(path, { ...init, body: JSON.stringify({ ...row, instructions: "Another Start's instructions." }) })
      return Response.json({ error: { message: "a session already exists under that id" } }, { status: 409 })
    })

    const refused = await kit.start(await startCommand(previewed.preview.digest))
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "conflict", message: expect.stringContaining("already running another configuration") },
    })
    expect(host.calls.filter((call) => call.path.startsWith("/session?"))).toHaveLength(1)
    expect(host.calls.some((call) => call.path.endsWith("/prompt_async"))).toBe(false)
  })

  test("repairs session metadata lost after the create, so the attempt stops reading as deleted", async () => {
    runtime()
    const composition = services()
    const kit = bridge(composition)
    const previewed = await kit.preview(previewCommand())
    if (!previewed.ok) throw new Error("preview refused")
    const started = await kit.start(await startCommand(previewed.preview.digest))
    expect(started).toMatchObject({ ok: true })
    if (!started.ok) return
    const session = started.session.sessionRef

    const origin = { scopeId: "org", taskId: "tsk_1", slot, attempt: 1, sessionRef: session }
    composition.metas.delete(session.sessionId)
    expect(await kit.sessionState([origin])).toEqual([{ session, state: "deleted", handoff: "unknown" }])

    const again = await kit.start(await startCommand(previewed.preview.digest))
    expect(again).toMatchObject({ ok: true })
    expect(await kit.sessionState([origin])).toEqual([{ session, state: "live", handoff: "pending" }])
  })


  test("stops rather than reserving as itself when a supplied resolver names nobody", async () => {
    const host = runtime()
    const composition = services()
    const kit = bridge(composition, async () => undefined)
    const previewed = await kit.preview(previewCommand())
    if (!previewed.ok) throw new Error("preview refused")

    const started = await kit.start(await startCommand(previewed.preview.digest))
    expect(started).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(composition.authority.reserveRuntimeSession).not.toHaveBeenCalled()
    expect(host.calls.some((call) => call.path.startsWith("/session?"))).toBe(false)
  })

  test("reports the authority's own workspace refusal as a Start failure", async () => {
    const host = runtime()
    const composition = services()
    composition.authority.reserveRuntimeSession.mockRejectedValue(
      new ControlPlaneAuthError(403, "workspace_authorization_denied", "Session authorization was denied"),
    )
    const kit = bridge(composition)
    const previewed = await kit.preview(previewCommand())
    if (!previewed.ok) throw new Error("preview refused")

    const started = await kit.start(await startCommand(previewed.preview.digest))
    expect(started).toMatchObject({
      ok: false,
      error: { code: "forbidden", message: "Session authorization was denied" },
    })
    expect(host.calls.some((call) => call.path.startsWith("/session?"))).toBe(false)
  })

  test("lets a reservation fault travel instead of reporting it as a refusal", async () => {
    runtime()
    const composition = services()
    composition.authority.reserveRuntimeSession.mockRejectedValue(new Error("D1 is unreachable"))
    const kit = bridge(composition)
    const previewed = await kit.preview(previewCommand())
    if (!previewed.ok) throw new Error("preview refused")

    await expect(kit.start(await startCommand(previewed.preview.digest))).rejects.toThrow("D1 is unreachable")
  })


  test("gives an unlinked session back and compensates the reservation that admitted it", async () => {
    const host = runtime()
    const composition = services()
    const kit = bridge(composition)
    const previewed = await kit.preview(previewCommand())
    if (!previewed.ok) throw new Error("preview refused")
    const started = await kit.start(await startCommand(previewed.preview.digest))
    if (!started.ok) throw new Error("start refused")
    const session = started.session.sessionRef

    const abandoned = await kit.abandon({
      actor,
      task: task(),
      slot,
      attempt: 1,
      configurationDigest: await startConfigurationDigest({ preset: preset(), slot }),
      sessionRef: session,
    })
    expect(abandoned).toMatchObject({ ok: true, removed: true })
    expect(host.sessions.has(session.sessionId)).toBe(false)
    expect(composition.metas.has(session.sessionId)).toBe(false)

    const transition = expect.objectContaining({
      operationId: await operationIdOf(),
      sessionId: session.sessionId,
      workspaceId: "ws_cloud",
    })
    expect(composition.authority.beginSessionCompensation).toHaveBeenCalledWith(transition)
    expect(composition.authority.completeSessionCompensation).toHaveBeenCalledWith(transition)

    // The origin is free, so a Start under another configuration reserves it
    // rather than colliding with the session that was taken back.
    const rewritten: Preset = { ...preset(), revision: 3, instructions: "Ignore the code and rewrite it." }
    const again = await kit.preview({ ...previewCommand(), preset: rewritten })
    if (!again.ok) throw new Error("preview refused")
    expect(await kit.start(await startCommand(again.preview.digest, rewritten))).toMatchObject({ ok: true })
  })

  test("keeps a session the task already reached, and keeps the reservation when the delete is refused", async () => {
    const host = runtime({ refuseDelete: true })
    const composition = services()
    const kit = bridge(composition)
    const previewed = await kit.preview(previewCommand())
    if (!previewed.ok) throw new Error("preview refused")
    const started = await kit.start(await startCommand(previewed.preview.digest))
    if (!started.ok) throw new Error("start refused")
    const session = started.session.sessionRef
    const command = {
      actor,
      task: task(),
      slot,
      attempt: 1,
      configurationDigest: await startConfigurationDigest({ preset: preset(), slot }),
      sessionRef: session,
    }

    const refused = await kit.abandon(command)
    expect(refused).toMatchObject({ ok: false, error: { code: "unsupported" } })
    expect(host.sessions.has(session.sessionId)).toBe(true)
    expect(composition.authority.beginSessionCompensation).not.toHaveBeenCalled()

    expect(await kit.handoff(handoffCommand(session))).toMatchObject({ ok: true, sent: true })
    const kept = await kit.abandon(command)
    expect(kept).toMatchObject({ ok: true, removed: false })
    expect(composition.authority.beginSessionCompensation).not.toHaveBeenCalled()
    expect(composition.metas.has(session.sessionId)).toBe(true)
  })


  test("blocks a cloud preset on a deployment with no sandbox driver, and never reserves an origin for one", async () => {
    const host = runtime()
    const composition = services()
    const kit = bridge(composition)
    const cloud: Preset = {
      ...preset(),
      execution: { placement: "cloud", capabilities: { mode: "selected", plugins: [], skills: [] } },
    }
    const previewed = await kit.preview({ ...previewCommand(), preset: cloud })
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview.blockers).toEqual([
      { code: "placement_unsupported", detail: expect.stringContaining("No cloud sandbox driver is configured") },
    ])

    const started = await kit.start(await startCommand(previewed.preview.digest, cloud))
    expect(started).toMatchObject({ ok: false, error: { code: "unsupported" } })
    expect(composition.authority.reserveRuntimeSession).not.toHaveBeenCalled()
    expect(host.calls.some((call) => call.path.startsWith("/session?"))).toBe(false)
  })
})
