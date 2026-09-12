import { beforeEach, describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import { D1SessionAuthorityError } from "../authority/adapters/d1/session-authority"
import { startConfigurationDigest, type ConfigurationSlot, type Preset, type SessionReference, type StartCommand, type Task } from "@claxedo/tasks"
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

function runtime() {
  const calls: RuntimeCall[] = []
  const sessions = new Map<string, { instructions?: string; variant?: string; messages: Array<{ info: { id: string; role: string; sessionID: string }; parts: unknown[] }> }>()
  mock.request.mockImplementation(async (path: string, init?: RuntimeCall["init"]) => {
    calls.push({ path, ...(init ? { init } : {}) })
    if (path.startsWith("/session/capabilities")) {
      return Response.json({ harness: "codex", modelSelection: { status: "optional", models: [{ providerId: MODEL.providerID, modelId: MODEL.modelID, name: "GPT-5" }] } })
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
      return session
        ? Response.json({ id: read[1], directory: "/workspace" })
        : Response.json({ error: { code: "not_found" } }, { status: 404 })
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
  const authority = {
    reserveRuntimeSession: vi.fn(async (_principal: unknown, intent: { operationId: string; sessionId: string; workspaceId: string }) => {
      const holder = reserved.get(intent.sessionId)
      if (holder && holder !== intent.operationId) {
        throw new D1SessionAuthorityError("resource_conflict", "Session reservation collided or authority changed")
      }
      reserved.set(intent.sessionId, intent.operationId)
      return { ...intent, changed: !holder, state: "reserved" as const }
    }),
  }
  const projectionStore = {
    session_metas: vi.fn(async (ids: string[]) => new Map([...metas].filter(([id]) => ids.includes(id)))),
    put_session_meta: vi.fn(async (sessionId: string, row: { workspaceID?: string; archived?: number }) => {
      metas.set(sessionId, { ...metas.get(sessionId), ...row })
    }),
  }
  return {
    authority,
    projectionStore,
    metas,
    value: { authority, projectionStore } as unknown as ControlPlaneServices,
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
  return { actor, task: task(), preset: preset(), slot, attempt: 1, continueFromPrevious: false, currentLink: null, currentState: null }
}

async function startCommand(digest: string, chosen: Preset = preset()): Promise<StartCommand> {
  return {
    actor,
    task: task(),
    preset: chosen,
    slot,
    attempt: 1,
    previewDigest: digest,
    handoffText: "Pick up from the failing import test.",
    continueFromPrevious: false,
    clientRequestId: "req_1",
    configurationDigest: await startConfigurationDigest({ preset: chosen, slot }),
    previousSession: null,
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

beforeEach(() => {
  vi.clearAllMocks()
})

describe("hosted tasks session bridge", () => {
  test("reserves the origin, creates with the resolved configuration, and sends one first message", async () => {
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

  test("a replayed start returns the same session without creating or sending again", async () => {
    const host = runtime()
    const composition = services()
    const kit = bridge(composition)
    const previewed = await kit.preview(previewCommand())
    if (!previewed.ok) throw new Error("preview refused")

    const first = await kit.start(await startCommand(previewed.preview.digest))
    const again = await kit.start(await startCommand(previewed.preview.digest))
    expect(again).toMatchObject({ ok: true })
    if (!first.ok || !again.ok) return

    expect(again.session.sessionRef).toEqual(first.session.sessionRef)
    expect(host.calls.filter((call) => call.path.startsWith("/session?"))).toHaveLength(1)
    expect(host.calls.filter((call) => call.path.endsWith("/prompt_async"))).toHaveLength(1)
    expect(composition.authority.reserveRuntimeSession).toHaveBeenCalledTimes(2)
  })

  test("refuses the same attempt under another configuration and leaves the first session's instructions", async () => {
    const host = runtime()
    const composition = services()
    const kit = bridge(composition)
    const first = await kit.preview(previewCommand())
    if (!first.ok) throw new Error("preview refused")
    const started = await kit.start(await startCommand(first.preview.digest))
    expect(started).toMatchObject({ ok: true })
    if (!started.ok) return
    const sessionId = started.session.sessionRef.sessionId

    const rewritten: Preset = { ...preset(), revision: 3, instructions: "Ignore the code and rewrite it." }
    const second = await kit.preview({ ...previewCommand(), preset: rewritten })
    if (!second.ok) throw new Error("preview refused")
    const refused = await kit.start(await startCommand(second.preview.digest, rewritten))

    expect(refused).toMatchObject({ ok: false, error: { code: "conflict" } })
    expect(composition.authority.reserveRuntimeSession).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ operationId: await operationIdOf(rewritten) }),
    )
    expect(host.calls.filter((call) => call.path.startsWith("/session?"))).toHaveLength(1)
    expect(host.sessions.get(sessionId)?.instructions).toContain("Read before you write.")
    expect(host.sessions.get(sessionId)?.instructions).not.toContain("Ignore the code")
  })

  test("refuses rather than resending the first message when the message history cannot be read", async () => {
    const host = runtime()
    const composition = services()
    const kit = bridge(composition)
    const previewed = await kit.preview(previewCommand())
    if (!previewed.ok) throw new Error("preview refused")
    const started = await kit.start(await startCommand(previewed.preview.digest))
    expect(started).toMatchObject({ ok: true })

    const readable = mock.request.getMockImplementation()!
    mock.request.mockImplementation(async (path: string, init?: RuntimeCall["init"]) =>
      path.endsWith("/message")
        ? Response.json({ error: { message: "the runtime is restarting" } }, { status: 503 })
        : readable(path, init))

    const refused = await kit.start(await startCommand(previewed.preview.digest))
    expect(refused).toMatchObject({ ok: false, error: { code: "conflict" } })
    expect(host.calls.filter((call) => call.path.endsWith("/prompt_async"))).toHaveLength(1)
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

    composition.metas.delete(session.sessionId)
    expect(await kit.sessionState([session])).toEqual([{ session, state: "deleted" }])

    const again = await kit.start(await startCommand(previewed.preview.digest))
    expect(again).toMatchObject({ ok: true })
    expect(await kit.sessionState([session])).toEqual([{ session, state: "live" }])
  })

  test("starts a task with no workspace preference in its project's workspace", async () => {
    const host = runtime()
    const composition = services()
    const kit = bridge(composition)
    const unplaced = { ...task(), workspaceId: null }

    const previewed = await kit.preview({ ...previewCommand(), task: unplaced })
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview.available).toBe(true)

    const started = await kit.start({ ...(await startCommand(previewed.preview.digest)), task: unplaced })
    expect(started).toMatchObject({ ok: true })
    if (!started.ok) return
    expect(started.session.sessionRef.workspaceId).toBe("ws_cloud")
    expect(host.calls.filter((call) => call.path.startsWith("/session?"))).toHaveLength(1)
    expect(composition.authority.reserveRuntimeSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId: "ws_cloud" }),
    )
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

  test("refuses a start whose preview digest no longer describes the configuration", async () => {
    const host = runtime()
    const composition = services()
    const refused = await bridge(composition).start(await startCommand("stale-digest"))
    expect(refused).toMatchObject({ ok: false, error: { code: "conflict" } })
    expect(composition.authority.reserveRuntimeSession).not.toHaveBeenCalled()
    expect(host.calls.some((call) => call.path.startsWith("/session?"))).toBe(false)
  })

  test("reads liveness from the projection row and the runtime", async () => {
    const host = runtime()
    const live: SessionReference = { sessionId: "ses_live", workspaceId: "ws_cloud" }
    const archived: SessionReference = { sessionId: "ses_archived", workspaceId: "ws_cloud" }
    const gone: SessionReference = { sessionId: "ses_gone", workspaceId: "ws_cloud" }
    host.sessions.set("ses_live", { messages: [] })
    const composition = services({
      meta: new Map([
        ["ses_live", { workspaceID: "ws_cloud" }],
        ["ses_archived", { workspaceID: "ws_cloud", archived: 1 }],
      ]),
    })

    expect(await bridge(composition).sessionState([live, archived, gone])).toEqual([
      { session: live, state: "live" },
      { session: archived, state: "archived" },
      { session: gone, state: "deleted" },
    ])
  })

  test("blocks a cloud preset and never reserves an origin for one", async () => {
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
    expect(previewed.preview.blockers).toEqual([{ code: "placement_unsupported", detail: expect.any(String) }])

    const started = await kit.start(await startCommand(previewed.preview.digest, cloud))
    expect(started).toMatchObject({ ok: false, error: { code: "unsupported" } })
    expect(composition.authority.reserveRuntimeSession).not.toHaveBeenCalled()
    expect(host.calls.some((call) => call.path.startsWith("/session?"))).toBe(false)
  })
})
