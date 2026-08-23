import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import type { RuntimeEventEnvelope } from "@claxedo/agent-sdk-runtime/runtime-event-hub"
import { createVirtualSessionEnv, type SessionEnv, type SessionEnvFactoryInput } from "@claxedo/agent-sdk-runtime"
import { requirePiModel, type PiModelBackend, type PiModelBackendResolver } from "@claxedo/agent-sdk-runtime/adapters"
import { createCentralSessionRuntime } from "./runtime"
import { createCentralControlApp } from "../central-runtime"
import { createConnectionTurnCredentials } from "../connections/turn-credentials"
import { piProviderCatalog } from "@claxedo/server-core/credentials/pi-provider-catalog"
import type { TurnUsageRevision } from "@claxedo/server-core/usage/contracts"

function services(): ControlPlaneServices {
  return {
    projectionStore: {
      sync_session_meta: vi.fn(async () => {}),
      sync_session_metas: vi.fn(async () => {}),
      sync_session_messages: vi.fn(async () => {}),
      put_session_meta: vi.fn(async () => {}),
      delete_session_meta: vi.fn(async () => {}),
      session_meta: vi.fn(async () => undefined),
      session_metas: vi.fn(async () => new Map()),
      list_session_metas: vi.fn(async () => []),
      tagged_session_metas: vi.fn(async () => []),
      read_session_messages: vi.fn(() => []),
      read_session_max_event_ordinal: vi.fn(() => 0),
    },
    durableSessionLog: {
      persist_message_event: vi.fn(),
      subscribe_message_replay: vi.fn(() => () => {}),
    },
    auth: localOnlyAuthAdapter(),
    credentials: {} as never,
    extensionPolicy: {},
    relay: {},
    sandbox: {},
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: true },
  }
}

function successfulModelBackend(text = "child result"): PiModelBackendResolver {
  return (input) => {
    if (!input.model) return undefined
    const streamFn: NonNullable<PiModelBackend["streamFn"]> = (model) => {
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "start" as const, partial: { ...message, content: [] } }
          yield { type: "text_start" as const, contentIndex: 0, partial: { ...message, content: [] } }
          yield { type: "text_delta" as const, contentIndex: 0, delta: text, partial: message }
          yield { type: "text_end" as const, contentIndex: 0, content: text, partial: message }
          yield { type: "done" as const, reason: "stop" as const, message }
        },
        result: async () => message,
      } as unknown as ReturnType<NonNullable<PiModelBackend["streamFn"]>>
    }
    return { model: requirePiModel(input.model), getApiKey: () => "test-key", streamFn }
  }
}

function blockingModelBackend(started: (sessionId: string) => void): PiModelBackendResolver {
  return (input) => {
    if (!input.model) return undefined
    const streamFn: NonNullable<PiModelBackend["streamFn"]> = (model, _context, options) => {
      const failed = {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error" as const,
        errorMessage: "aborted",
        timestamp: Date.now(),
      }
      return {
        async *[Symbol.asyncIterator]() {
          started(input.sessionId)
          await new Promise<void>((resolveAbort) => {
            if (options?.signal?.aborted) return resolveAbort()
            options?.signal?.addEventListener("abort", () => resolveAbort(), { once: true })
          })
          yield { type: "error" as const, reason: "error" as const, error: failed }
        },
        result: async () => failed,
      } as unknown as ReturnType<NonNullable<PiModelBackend["streamFn"]>>
    }
    return { model: requirePiModel(input.model), getApiKey: () => "test-key", streamFn }
  }
}

function abortableEnv(input: { started: () => void }): SessionEnv {
  return {
    kind: "virtual",
    cwd: () => "/",
    resolvePath: (path = ".") => path,
    exec: (_command, options) => new Promise((resolve, reject) => {
      input.started()
      const abort = () => reject(new Error("central turn aborted"))
      if (options?.signal?.aborted) {
        abort()
        return
      }
      options?.signal?.addEventListener("abort", abort, { once: true })
    }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    stat: async () => ({
      isFile: false,
      isDirectory: false,
      isSymbolicLink: false,
      size: 0,
      mtimeMs: 0,
    }),
    readdir: async () => [],
    exists: async () => false,
    mkdir: async () => {},
    rm: async () => {},
  }
}

async function eventually(fn: () => void) {
  let error: unknown
  for (let i = 0; i < 20; i++) {
    try {
      fn()
      return
    } catch (err) {
      error = err
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
  throw error
}

describe("createCentralSessionRuntime", () => {
  test("admits a cloud worktree before binding and reuses exact retry identity", async () => {
    const svc = services()
    let meta: Awaited<ReturnType<typeof svc.projectionStore.session_meta>>
    const sessionMeta = svc.projectionStore.session_meta as ReturnType<typeof vi.fn>
    const putSessionMeta = svc.projectionStore.put_session_meta as ReturnType<typeof vi.fn>
    sessionMeta.mockImplementation(async () => meta)
    putSessionMeta.mockImplementation(async (sessionID, input) => {
      meta = {
        sessionID,
        host: "central",
        workspaceID: input.workspaceID ?? undefined,
        toolSandbox: input.toolSandbox ?? undefined,
        title: input.title ?? undefined,
        createdAt: 1,
        updatedAt: 1,
        tags: [],
        attachments: [],
      }
    })
    const placements: SessionEnvFactoryInput[] = []
    const admitWorkspaceSession = vi.fn(async () => ({
      directory: "/home/runtime/.claxedo/workspaces/ws-cloud/worktrees/session-cloud",
      worktree: "claxedo/session/session-cloud",
      baseCommit: "a".repeat(40),
      leaseEpoch: 7,
    }))
    const runtime = createCentralSessionRuntime(svc, {
      admitWorkspaceSession,
      createEnv: async (input) => {
        placements.push(input)
        return createVirtualSessionEnv()
      },
    })
    const input = {
      sessionId: "session-cloud",
      title: "Cloud",
      workspaceId: "ws-cloud",
      toolSandbox: { kind: "workspace-runtime" as const, workspaceId: "ws-cloud" },
    }

    await expect(runtime.createHybridSession(input)).resolves.toEqual({ id: "session-cloud" })
    await expect(runtime.createHybridSession(input)).resolves.toEqual({ id: "session-cloud" })

    expect(admitWorkspaceSession).toHaveBeenCalledWith({
      sessionId: "session-cloud",
      workspaceId: "ws-cloud",
    })
    expect(placements).toHaveLength(1)
    expect(placements[0]?.toolSandbox).toEqual({
      kind: "workspace-runtime",
      workspaceId: "ws-cloud",
      directory: "/home/runtime/.claxedo/workspaces/ws-cloud/worktrees/session-cloud",
      worktree: "claxedo/session/session-cloud",
      baseCommit: "a".repeat(40),
      leaseEpoch: 7,
    })
    expect(meta?.toolSandbox).toEqual(placements[0]?.toolSandbox)
  })

  test("rejects a malformed explicit deployment model instead of auto-selecting", async () => {
    const priorModel = process.env.CLAXEDO_PI_MODEL
    process.env.CLAXEDO_PI_MODEL = "anthropic"
    try {
      await expect(createCentralSessionRuntime(services()).createHybridSession({
        title: "Malformed default",
        requireModel: true,
      })).rejects.toThrow("provider/model syntax")
    } finally {
      if (priorModel === undefined) delete process.env.CLAXEDO_PI_MODEL
      else process.env.CLAXEDO_PI_MODEL = priorModel
    }
  })

  test("persists the resolved deployment default for a root non-UI session", async () => {
    const priorModel = process.env.CLAXEDO_PI_MODEL
    const priorKey = process.env.ANTHROPIC_API_KEY
    const modelID = Object.keys(piProviderCatalog().all.find((provider) => provider.id === "anthropic")!.models)[0]!
    process.env.CLAXEDO_PI_MODEL = `anthropic/${modelID}`
    process.env.ANTHROPIC_API_KEY = "test-key"
    try {
      const svc = services()
      const runtime = createCentralSessionRuntime(svc)
      const session = await runtime.createHybridSession({ title: "Defaulted" })

      expect(svc.projectionStore.put_session_meta).toHaveBeenLastCalledWith(session.id, expect.objectContaining({
        model: { providerID: "anthropic", modelID },
      }))
      const config = await runtime.routes.request(`http://127.0.0.1/session/${session.id}/config`)
      await expect(config.json()).resolves.toMatchObject({ model: { providerID: "anthropic", modelID } })
    } finally {
      if (priorModel === undefined) delete process.env.CLAXEDO_PI_MODEL
      else process.env.CLAXEDO_PI_MODEL = priorModel
      if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = priorKey
    }
  })

  test("U9: Pi foreground subagent inherits placement, streams progress, and returns final text", async () => {
    const priorEnabled = process.env.CLAXEDO_PI_MODEL_BACKEND
    const priorKey = process.env.ANTHROPIC_API_KEY
    process.env.CLAXEDO_PI_MODEL_BACKEND = "1"
    process.env.ANTHROPIC_API_KEY = "test-key"
    try {
      const svc = services()
      const placements: SessionEnvFactoryInput[] = []
      const runtime = createCentralSessionRuntime(svc, {
        modelBackend: successfulModelBackend(),
        createEnv: async (input) => {
          placements.push(input)
          return createVirtualSessionEnv()
        },
      })
      const runtimeEvents: RuntimeEventEnvelope[] = []
      runtime.eventHub.subscribeRuntime((event) => runtimeEvents.push(event))
      const updates: unknown[] = []
      const modelID = Object.keys(piProviderCatalog().all.find((provider) => provider.id === "anthropic")!.models)[0]!
      const source = await runtime.createHybridSession({
        title: "Source",
        model: { providerID: "anthropic", modelID },
        workspaceId: "ws_parent",
        toolSandbox: { kind: "workspace-runtime", workspaceId: "ws_parent", directory: "/work/parent" },
      })
      const child = await runtime.createDispatchedSession(source.id, {
        task: "Return a concise result",
        title: "Child",
        toolCallId: "tool-foreground",
        onUpdate: (update) => updates.push(update),
      })

      expect(child).toMatchObject({ status: "completed", text: "child result" })
      expect(runtimeEvents.filter((event) => event.sessionId === source.id).map((event) =>
        event.payload.type === "subagent-updated" ? event.payload.status : undefined,
      ).filter(Boolean)).toEqual(["pending", "running", "completed"])
      expect(runtimeEvents.filter((event) => event.sessionId === child.childSessionId).some((event) =>
        event.payload.type === "text-delta",
      )).toBe(true)
      expect(runtimeEvents).toContainEqual(expect.objectContaining({
        sessionId: child.childSessionId,
        payload: expect.objectContaining({ type: "session-info", parentID: source.id }),
      }))
      expect(updates.length).toBeGreaterThan(2)
      expect(placements).toHaveLength(2)
      expect(placements[1]).toMatchObject({
        workspaceId: "ws_parent",
        toolSandbox: { kind: "workspace-runtime", workspaceId: "ws_parent", directory: "/work/parent" },
      })
      expect(svc.projectionStore.put_session_meta).toHaveBeenCalledWith(child.childSessionId, expect.objectContaining({
        parentID: source.id,
        workspaceID: "ws_parent",
        model: { providerID: "anthropic", modelID },
        tags: expect.arrayContaining([
          `subagent-key:${child.subagentKey}`,
          "subagent-tool-call:tool-foreground",
        ]),
      }))
      const config = await runtime.routes.request(`http://127.0.0.1/session/${child.childSessionId}/config`)
      await expect(config.json()).resolves.toMatchObject({ model: { providerID: "anthropic", modelID } })
      const rootCapabilities = await runtime.routes.request(`http://127.0.0.1/session/${source.id}/capabilities`)
      const childCapabilities = await runtime.routes.request(`http://127.0.0.1/session/${child.childSessionId}/capabilities`)
      await expect(rootCapabilities.json()).resolves.toMatchObject({ subagents: true })
      await expect(childCapabilities.json()).resolves.toMatchObject({ subagents: false })

      const settledUpdateCount = updates.length
      runtime.eventHub.publishRuntime({
        directory: child.childSessionId,
        sessionId: child.childSessionId,
        payload: { type: "text-delta", delta: "after settlement" },
      })
      expect(updates).toHaveLength(settledUpdateCount)
    } finally {
      if (priorEnabled === undefined) delete process.env.CLAXEDO_PI_MODEL_BACKEND
      else process.env.CLAXEDO_PI_MODEL_BACKEND = priorEnabled
      if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = priorKey
    }
  })

  test("U9: native subagent tool schema cannot select another workspace", async () => {
    const tool = createCentralSessionRuntime(services()).subagentToolForSession("parent")
    const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}

    expect(tool.name).toBe("subagent")
    expect(Object.keys(properties).sort()).toEqual(["background", "task", "title"])
    expect(JSON.stringify(tool)).not.toContain("workspace_id")
  })

  test("U9: background subagents return immediately, enforce the parent limit, and persist host kills", async () => {
    const priorEnabled = process.env.CLAXEDO_PI_MODEL_BACKEND
    const priorKey = process.env.ANTHROPIC_API_KEY
    process.env.CLAXEDO_PI_MODEL_BACKEND = "1"
    process.env.ANTHROPIC_API_KEY = "test-key"
    try {
      const started: string[] = []
      const runtime = createCentralSessionRuntime(services(), {
        modelBackend: blockingModelBackend((sessionId) => started.push(sessionId)),
      })
      const modelID = Object.keys(piProviderCatalog().all.find((provider) => provider.id === "anthropic")!.models)[0]!
      const source = await runtime.createHybridSession({
        title: "Source",
        model: { providerID: "anthropic", modelID },
      })
      const children = await Promise.all([0, 1, 2, 3].map((index) => runtime.createDispatchedSession(source.id, {
        task: `background ${index}`,
        background: true,
        toolCallId: `tool-background-${index}`,
      })))

      expect(children.every((child) => child.status === "running")).toBe(true)
      await eventually(() => expect(started).toHaveLength(4))
      await expect(runtime.createDispatchedSession(source.id, {
        task: "fifth",
        background: true,
      })).rejects.toThrow("at most 4")

      await Promise.all(children.map((child) => runtime.terminateSubagent(source.id, child.subagentKey)))
      await eventually(() => {
        expect(runtime.listSubagents(source.id)).toEqual(expect.arrayContaining(children.map((child) =>
          expect.objectContaining({ subagentKey: child.subagentKey, status: "killed" }),
        )))
      })
    } finally {
      if (priorEnabled === undefined) delete process.env.CLAXEDO_PI_MODEL_BACKEND
      else process.env.CLAXEDO_PI_MODEL_BACKEND = priorEnabled
      if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = priorKey
    }
  })

  test("U10: archiving or deleting a parent interrupts its active Pi background children", async () => {
    const priorEnabled = process.env.CLAXEDO_PI_MODEL_BACKEND
    const priorKey = process.env.ANTHROPIC_API_KEY
    process.env.CLAXEDO_PI_MODEL_BACKEND = "1"
    process.env.ANTHROPIC_API_KEY = "test-key"
    try {
      const started: string[] = []
      const runtime = createCentralSessionRuntime(services(), {
        modelBackend: blockingModelBackend((sessionId) => started.push(sessionId)),
      })
      const modelID = Object.keys(piProviderCatalog().all.find((provider) => provider.id === "anthropic")!.models)[0]!
      const archivedParent = await runtime.createHybridSession({
        title: "Archived parent",
        model: { providerID: "anthropic", modelID },
      })
      const archivedChild = await runtime.createDispatchedSession(archivedParent.id, {
        task: "background until archive",
        background: true,
        toolCallId: "tool-archive",
      })
      await eventually(() => expect(started).toContain(archivedChild.childSessionId))

      const archived = await runtime.routes.request(`http://127.0.0.1/session/${archivedParent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ time: { archived: Date.now() } }),
      })
      expect(archived.status).toBe(200)
      await eventually(() => expect(runtime.listSubagents(archivedParent.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ subagentKey: archivedChild.subagentKey, status: "interrupted" }),
      ])))

      const deletedParent = await runtime.createHybridSession({
        title: "Deleted parent",
        model: { providerID: "anthropic", modelID },
      })
      const deletedChild = await runtime.createDispatchedSession(deletedParent.id, {
        task: "background until delete",
        background: true,
        toolCallId: "tool-delete",
      })
      await eventually(() => expect(started).toContain(deletedChild.childSessionId))

      const deleted = await runtime.routes.request(`http://127.0.0.1/session/${deletedParent.id}`, { method: "DELETE" })
      expect(deleted.status).toBe(200)
      expect(await runtime.terminateSubagent(deletedParent.id, deletedChild.subagentKey)).toBe(false)
    } finally {
      if (priorEnabled === undefined) delete process.env.CLAXEDO_PI_MODEL_BACKEND
      else process.env.CLAXEDO_PI_MODEL_BACKEND = priorEnabled
      if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = priorKey
    }
  })

  test("U9: background subagents time out into a persisted failed lifecycle", async () => {
    const priorEnabled = process.env.CLAXEDO_PI_MODEL_BACKEND
    const priorKey = process.env.ANTHROPIC_API_KEY
    process.env.CLAXEDO_PI_MODEL_BACKEND = "1"
    process.env.ANTHROPIC_API_KEY = "test-key"
    try {
      const runtime = createCentralSessionRuntime(services(), {
        modelBackend: blockingModelBackend(() => undefined),
        subagentTimeoutMs: 5,
      })
      const modelID = Object.keys(piProviderCatalog().all.find((provider) => provider.id === "anthropic")!.models)[0]!
      const source = await runtime.createHybridSession({
        title: "Source",
        model: { providerID: "anthropic", modelID },
      })
      const child = await runtime.createDispatchedSession(source.id, {
        task: "wait forever",
        background: true,
        toolCallId: "tool-timeout",
      })

      await eventually(() => expect(runtime.listSubagents(source.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ subagentKey: child.subagentKey, status: "failed" }),
      ])))
    } finally {
      if (priorEnabled === undefined) delete process.env.CLAXEDO_PI_MODEL_BACKEND
      else process.env.CLAXEDO_PI_MODEL_BACKEND = priorEnabled
      if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = priorKey
    }
  })

  test("U9: aborting the foreground tool aborts its child before settlement", async () => {
    const priorEnabled = process.env.CLAXEDO_PI_MODEL_BACKEND
    const priorKey = process.env.ANTHROPIC_API_KEY
    process.env.CLAXEDO_PI_MODEL_BACKEND = "1"
    process.env.ANTHROPIC_API_KEY = "test-key"
    try {
      const started: string[] = []
      const runtime = createCentralSessionRuntime(services(), {
        modelBackend: blockingModelBackend((sessionId) => started.push(sessionId)),
      })
      const modelID = Object.keys(piProviderCatalog().all.find((provider) => provider.id === "anthropic")!.models)[0]!
      const source = await runtime.createHybridSession({
        title: "Source",
        model: { providerID: "anthropic", modelID },
      })
      const abort = new AbortController()
      const child = runtime.createDispatchedSession(source.id, {
        task: "block",
        toolCallId: "tool-abort",
        signal: abort.signal,
      })
      await eventually(() => expect(started).toHaveLength(1))
      abort.abort()

      await expect(child).resolves.toMatchObject({ status: "interrupted" })
      expect(runtime.listSubagents(source.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "interrupted" }),
      ]))
    } finally {
      if (priorEnabled === undefined) delete process.env.CLAXEDO_PI_MODEL_BACKEND
      else process.env.CLAXEDO_PI_MODEL_BACKEND = priorEnabled
      if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = priorKey
    }
  })

  test("persists config PATCH model selection and restores it after runtime reconstruction", async () => {
    const priorEnabled = process.env.CLAXEDO_PI_MODEL_BACKEND
    const priorKey = process.env.ANTHROPIC_API_KEY
    process.env.CLAXEDO_PI_MODEL_BACKEND = "1"
    process.env.ANTHROPIC_API_KEY = "test-key"
    try {
      const svc = services()
      let meta: Awaited<ReturnType<typeof svc.projectionStore.session_meta>>
      const sessionMetaMock = svc.projectionStore.session_meta as ReturnType<typeof vi.fn>
      const putSessionMetaMock = svc.projectionStore.put_session_meta as ReturnType<typeof vi.fn>
      sessionMetaMock.mockImplementation(async () => meta)
      putSessionMetaMock.mockImplementation(async (sessionID, input) => {
        meta = {
          sessionID,
          host: "central",
          createdAt: meta?.createdAt ?? 1,
          updatedAt: 2,
          tags: [],
          attachments: [],
          ...(meta ?? {}),
          ...(input.model ? { model: input.model } : {}),
        }
      })
      const first = createCentralSessionRuntime(svc)
      const session = await first.createHybridSession({ title: "Durable model" })
      const modelID = Object.keys(piProviderCatalog().all.find((provider) => provider.id === "anthropic")!.models)[0]!

      const patch = await first.routes.request(`http://127.0.0.1/session/${session.id}/config`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: { providerID: "anthropic", modelID } }),
      })
      expect(patch.status).toBe(200)
      expect(meta?.model).toEqual({ providerID: "anthropic", modelID })

      const reconstructed = createCentralSessionRuntime(svc)
      const config = await reconstructed.routes.request(`http://127.0.0.1/session/${session.id}/config`)
      expect(config.status).toBe(200)
      await expect(config.json()).resolves.toMatchObject({ model: { providerID: "anthropic", modelID } })
    } finally {
      if (priorEnabled === undefined) delete process.env.CLAXEDO_PI_MODEL_BACKEND
      else process.env.CLAXEDO_PI_MODEL_BACKEND = priorEnabled
      if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = priorKey
    }
  })

  test("binds hybrid sessions to shared session routes and publishes runtime events", async () => {
    const svc = services()
    const runtime = createCentralSessionRuntime(svc)
    const events: RuntimeEventEnvelope[] = []
    runtime.eventHub.subscribeRuntime((event) => events.push(event))
    const session = await runtime.createHybridSession({ title: "Hybrid" })

    const res = await runtime.routes.request(`http://127.0.0.1/session/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "exec: printf hi" }],
        messageID: "user-1",
        agent: "pi",
        model: { providerID: "pi", modelID: "virtual" },
      }),
    })

    expect(res.status).toBe(200)
    expect(events.map((event) => event.payload.type)).toEqual([
      "session-info",
      "session-status",
      "text-delta",
      "session-status",
      "finish",
    ])
    expect(events).toContainEqual(expect.objectContaining({
      directory: session.id,
      sessionId: session.id,
      assistantMessageId: "user-1_r",
      payload: { type: "text-delta", delta: "hi" },
    }))
    expect(svc.projectionStore.put_session_meta).toHaveBeenCalledWith(session.id, {
      host: "central",
      directory: null,
      title: "Hybrid",
    })
    expect(svc.durableSessionLog.persist_message_event).toHaveBeenCalledWith(session.id, expect.objectContaining({
      type: "message.updated",
      properties: expect.objectContaining({
        info: expect.objectContaining({ id: "user-1", role: "user" }),
      }),
    }))
    expect(svc.durableSessionLog.persist_message_event).toHaveBeenCalledWith(session.id, expect.objectContaining({
      type: "message.part.updated",
      properties: expect.objectContaining({
        part: expect.objectContaining({ messageID: "user-1", text: "exec: printf hi" }),
      }),
    }))
    expect(svc.durableSessionLog.persist_message_event).toHaveBeenCalledWith(session.id, expect.objectContaining({
      type: "message.updated",
      properties: expect.objectContaining({
        info: expect.objectContaining({ id: "user-1_r", role: "assistant" }),
      }),
    }))
  })

  test("mints a subjectless turn credential for a loopback message route", async () => {
    const turns = createConnectionTurnCredentials({ random: () => "loopback-turn" })
    const control = createCentralControlApp(services(), { turnCredentials: turns })
    const session = await control.runtime.createHybridSession({ title: "Credential" })

    const res = await control.app.request(`http://127.0.0.1/api/control/session/${session.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "exec: printf credential" }],
        messageID: "turn-credential",
        agent: "pi",
        model: { providerID: "pi", modelID: "virtual" },
      }),
    })

    expect(res.status).toBe(200)
    expect(turns.resolve("loopback-turn")).toEqual({ sessionId: session.id })
    turns.dispose()
  })

  test("mints the signed subject at the central message entry point", async () => {
    const svc = services()
    const sessionId = "signed-session"
    svc.projectionStore.session_meta = vi.fn(async () => ({
      sessionID: sessionId,
      workspaceID: "workspace-1",
      host: "central" as const,
      title: "Signed",
      createdAt: 1,
      updatedAt: 1,
      tags: [],
      attachments: [],
    }))
    const authority = { authorizeSessionRead: vi.fn(async () => {}) }
    svc.authority = authority as never
    const turns = createConnectionTurnCredentials({ random: () => "signed-turn" })
    const control = createCentralControlApp(svc, {
      authConfig: { enabled: true, issuer: "https://issuer.example", jwksUrl: "https://issuer.example/jwks" },
      verifier: async () => ({
        mode: "signed",
        user: { subject: "user-a", tokenIdentifier: "user-a", issuer: "https://issuer.example" },
      }),
      turnCredentials: turns,
    })
    await control.runtime.createHybridSession({ title: "Signed" })

    const res = await control.app.request(`http://relay.example/api/control/session/${sessionId}/message`, {
      method: "POST",
      headers: { authorization: "Bearer signed-token", "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "exec: printf signed" }],
        messageID: "signed-message",
        agent: "pi",
        model: { providerID: "pi", modelID: "virtual" },
      }),
    })

    expect(res.status).toBe(200)
    expect(turns.resolve("signed-turn")).toEqual({ sessionId, subject: "user-a" })
    expect(authority.authorizeSessionRead).toHaveBeenCalledWith(expect.objectContaining({
      user: expect.objectContaining({ subject: "user-a" }),
    }), {
      sessionId,
      workspaceId: "workspace-1",
    })
    turns.dispose()
  })

  test("persists auto-title updates for central runtime sessions", async () => {
    const svc = services()
    const runtime = createCentralSessionRuntime(svc)
    const session = await runtime.createHybridSession({ title: "New session - 2026-07-08T09:09:30.378Z" })

    const res = await runtime.routes.request(`http://127.0.0.1/session/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "exec: printf titled" }],
        messageID: "user-title",
        agent: "pi",
        model: { providerID: "pi", modelID: "virtual" },
      }),
    })
    expect(res.status).toBe(200)

    const titled = await runtime.routes.request(`http://127.0.0.1/session/${session.id}`)
    expect(await titled.json()).toMatchObject({ id: session.id, title: "exec: printf titled" })
    await eventually(() => {
      expect(svc.projectionStore.put_session_meta).toHaveBeenCalledWith(session.id, {
        host: "central",
        directory: null,
        title: "exec: printf titled",
      })
    })
  })

  test("late-binds central hybrid envs with explicit placement", async () => {
    const svc = services()
    const placements: SessionEnvFactoryInput[] = []
    const runtime = createCentralSessionRuntime(svc, {
      createEnv: async (input) => {
        placements.push(input)
        return createVirtualSessionEnv()
      },
    })
    const session = await runtime.createHybridSession({
      title: "Hybrid",
      workspaceId: "workspace_1",
      toolSandbox: { kind: "virtual", id: "central-pi-test" },
    })

    expect(placements).toEqual([{
      sessionId: session.id,
      mode: "hybrid",
      host: "central",
      workspaceId: "workspace_1",
      toolSandbox: { kind: "virtual", id: "central-pi-test" },
    }])
    expect(svc.projectionStore.put_session_meta).toHaveBeenCalledWith(session.id, {
      host: "central",
      workspaceID: "workspace_1",
      directory: null,
      title: "Hybrid",
      tags: ["harness:pi"],
    })
  })

  test("swaps tool placement mid-conversation via PATCH /session/:id/placement", async () => {
    const svc = services()
    const placements: SessionEnvFactoryInput[] = []
    const disposed: string[] = []
    const runtime = createCentralSessionRuntime(svc, {
      createEnv: async (input) => {
        placements.push(input)
        const env = createVirtualSessionEnv()
        const dispose = env.dispose?.bind(env)
        return {
          ...env,
          dispose: async () => {
            disposed.push(input.toolSandbox?.kind ?? "none")
            await dispose?.()
          },
        }
      },
    })
    const session = await runtime.createHybridSession({
      title: "Swap",
      toolSandbox: { kind: "virtual", id: "before" },
    })

    const res = await runtime.routes.request(`http://127.0.0.1/session/${session.id}/placement`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolSandbox: { kind: "workspace-runtime", workspaceId: "ws-9", directory: "sub" } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; placement: { toolSandbox: { kind: string; workspaceId?: string } } }
    expect(body.ok).toBe(true)
    expect(body.placement.toolSandbox).toEqual({ kind: "workspace-runtime", workspaceId: "ws-9", directory: "sub" })
    // Old env disposed; new env created with the workspace-runtime placement.
    expect(disposed).toEqual(["virtual"])
    expect(placements.at(-1)).toMatchObject({
      sessionId: session.id,
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws-9", directory: "sub" },
    })
    // New placement persisted for recovery.
    expect(svc.projectionStore.put_session_meta).toHaveBeenCalledWith(session.id, expect.objectContaining({
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws-9", directory: "sub" },
      workspaceID: "ws-9",
    }))
  })

  test("placement swap rejects unknown sessions and malformed sandboxes", async () => {
    const runtime = createCentralSessionRuntime(services())
    const missing = await runtime.routes.request("http://127.0.0.1/session/nope/placement", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolSandbox: { kind: "virtual" } }),
    })
    expect(missing.status).toBe(404)

    const session = await runtime.createHybridSession({ title: "Bad input" })
    const malformed = await runtime.routes.request(`http://127.0.0.1/session/${session.id}/placement`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolSandbox: { kind: "workspace-runtime" } }),
    })
    expect(malformed.status).toBe(400)
  })

  test("persists workspace-runtime tool sandbox placement as a first-class field", async () => {
    const svc = services()
    const runtime = createCentralSessionRuntime(svc)
    const session = await runtime.createHybridSession({
      title: "Workspace runtime",
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws-1", directory: "sub" },
    })

    expect(svc.projectionStore.put_session_meta).toHaveBeenCalledWith(session.id, {
      host: "central",
      workspaceID: "ws-1",
      directory: null,
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws-1", directory: "sub" },
      title: "Workspace runtime",
      tags: ["harness:pi"],
    })
    const call = (svc.projectionStore.put_session_meta as ReturnType<typeof vi.fn>).mock.calls.find(
      ([id]) => id === session.id,
    )
    expect(call?.[1]).toHaveProperty("tags", ["harness:pi"])
  })

  test("omits the tool sandbox field for virtual and absent tool sandboxes", async () => {
    const svc = services()
    const runtime = createCentralSessionRuntime(svc)
    const session = await runtime.createHybridSession({ title: "Virtual" })

    const call = (svc.projectionStore.put_session_meta as ReturnType<typeof vi.fn>).mock.calls.find(
      ([id]) => id === session.id,
    )
    expect(call?.[1]).toEqual({
      host: "central",
      directory: null,
      title: "Virtual",
      tags: ["harness:pi"],
    })
    expect(call?.[1]).not.toHaveProperty("toolSandbox")
  })

  test("reconstructs a workspace-runtime tool sandbox from meta on recovery", async () => {
    const svc = services()
    svc.projectionStore.session_meta = vi.fn(async () => ({
      sessionID: "session-recover",
      workspaceID: "ws-1",
      host: "central" as const,
      title: "Recovered",
      createdAt: 1,
      updatedAt: 1,
      toolSandbox: { kind: "workspace-runtime" as const, workspaceId: "ws-1", directory: "sub" },
      tags: [],
      attachments: [],
    }))
    const placements: SessionEnvFactoryInput[] = []
    const runtime = createCentralSessionRuntime(svc, {
      createEnv: async (input) => {
        placements.push(input)
        return createVirtualSessionEnv()
      },
    })

    const res = await runtime.routes.request("http://127.0.0.1/session/session-recover")

    expect(res.status).toBe(200)
    expect(placements).toContainEqual({
      sessionId: "session-recover",
      mode: "hybrid",
      host: "central",
      workspaceId: "ws-1",
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws-1", directory: "sub" },
    })
  })

  test("recovery preserves a tool sandbox whose workspace differs from the session workspace", async () => {
    // Bug (a): session lives in ws_A, but its tools run in ws_B. The stored ref
    // must be reproduced verbatim on recovery — the tool sandbox's workspaceId
    // must NOT be rebuilt from the session's own workspaceID.
    const svc = services()
    svc.projectionStore.session_meta = vi.fn(async () => ({
      sessionID: "session-divergent",
      workspaceID: "ws_A",
      host: "central" as const,
      title: "Divergent",
      createdAt: 1,
      updatedAt: 1,
      toolSandbox: { kind: "workspace-runtime" as const, workspaceId: "ws_B", directory: "pkg" },
      tags: [],
      attachments: [],
    }))
    const placements: SessionEnvFactoryInput[] = []
    const runtime = createCentralSessionRuntime(svc, {
      createEnv: async (input) => {
        placements.push(input)
        return createVirtualSessionEnv()
      },
    })

    const res = await runtime.routes.request("http://127.0.0.1/session/session-divergent")

    expect(res.status).toBe(200)
    expect(placements).toContainEqual({
      sessionId: "session-divergent",
      mode: "hybrid",
      host: "central",
      // session's own workspace stays ws_A ...
      workspaceId: "ws_A",
      // ... while tools run in ws_B (verbatim, not rebuilt from ws_A).
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws_B", directory: "pkg" },
    })
  })

  test("createHybridSession keeps the session workspace distinct from a divergent tool sandbox", async () => {
    const svc = services()
    const runtime = createCentralSessionRuntime(svc)
    const session = await runtime.createHybridSession({
      title: "Divergent",
      workspaceId: "ws_A",
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws_B", directory: "pkg" },
    })

    expect(svc.projectionStore.put_session_meta).toHaveBeenCalledWith(session.id, {
      host: "central",
      workspaceID: "ws_A",
      directory: null,
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws_B", directory: "pkg" },
      title: "Divergent",
      tags: ["harness:pi"],
    })
  })

  test("tags channel-created central sessions with source provenance", async () => {
    const svc = services()
    const runtime = createCentralSessionRuntime(svc)
    const session = await runtime.createHybridSession({
      title: "Channel",
      sourceChannel: "telegram",
      sourceThreadKey: "telegram:bot:chat:thread",
    })

    expect(svc.projectionStore.put_session_meta).toHaveBeenCalledWith(session.id, {
      host: "central",
      directory: null,
      title: "Channel",
      tags: [
        "harness:pi",
        "source-channel:telegram",
        "source-thread:telegram:bot:chat:thread",
      ],
    })
  })

  test("replays hybrid runtime events through the central SSE endpoint", async () => {
    const runtime = createCentralSessionRuntime(services())
    const app = new Hono()
      .get("/api/claxedo/runtime-events", (c) => runtime.runtimeEvents(c as never))
    const session = await runtime.createHybridSession({ title: "Hybrid" })

    await runtime.routes.request(`http://127.0.0.1/session/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "exec: printf replayed" }],
        messageID: "user-replay",
        agent: "pi",
        model: { providerID: "pi", modelID: "virtual" },
      }),
    })

    const ac = new AbortController()
    const replay = await app.request("http://127.0.0.1/api/claxedo/runtime-events", {
      headers: { "Last-Event-ID": "2" },
      signal: ac.signal,
    })
    const next = await replay.body!.getReader().read()
    ac.abort()

    const frame = new TextDecoder().decode(next.value)
    expect(replay.status).toBe(200)
    expect(replay.headers.get("content-type")).toContain("text/event-stream")
    expect(frame).toContain("id: 3")
    expect(frame).toContain(`"sessionId":"${session.id}"`)
    expect(frame).toContain(`"directory":"${session.id}"`)
    expect(frame).toContain(`"assistantMessageId":"user-replay_r"`)
    expect(frame).toContain(`"delta":"replayed"`)
    expect(frame).not.toContain(`"status":"busy"`)
  })

  test("authorizes and scopes the central session runtime event route", async () => {
    const control = createCentralControlApp(services())
    const session = await control.runtime.createHybridSession({ title: "Hybrid" })

    await control.runtime.routes.request(`http://127.0.0.1/session/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "exec: printf scoped" }],
        messageID: "user-scoped",
        agent: "pi",
        model: { providerID: "pi", modelID: "virtual" },
      }),
    })

    const ac = new AbortController()
    const response = await control.app.request(
      `http://127.0.0.1/api/control/session/${session.id}/runtime-events?parentSessionId=${session.id}`,
      { headers: { "Last-Event-ID": "1" }, signal: ac.signal },
    )
    const next = await response.body!.getReader().read()
    ac.abort()

    expect(response.status).toBe(200)
    expect(new TextDecoder().decode(next.value)).toContain(`"sessionId":"${session.id}"`)
  })

  test("lets a local composition reserve the public usage path while retaining the control route", () => {
    const control = createCentralControlApp(services(), {
      usageLedger: {
        recordLlmTurn: async () => ({ activated: false }),
        usageDashboard: async () => ({ totals: {}, daily: [] }),
      },
      mountPublicUsageRoute: false,
    })
    const paths = control.app.routes.map((route) => route.path)
    expect(paths.some((path) => path.startsWith("/api/control/usage"))).toBe(true)
    expect(paths.some((path) => path.startsWith("/api/claxedo/usage"))).toBe(false)
  })

  test("aborts an active central hybrid turn through the session route", async () => {
    let started!: () => void
    const turnStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const usage: TurnUsageRevision[] = []
    const runtime = createCentralSessionRuntime(services(), {
      createEnv: async () => abortableEnv({ started }),
      usageRevisionStore: {
        writeRevision: async (fact) => {
          usage.push(structuredClone(fact))
          return { status: "accepted" }
        },
      },
      resolveUsageHostIdentity: async () => ({ hostId: "host-abort" }),
    })
    const events: RuntimeEventEnvelope[] = []
    runtime.eventHub.subscribeRuntime((event) => events.push(event))
    const session = await runtime.createHybridSession({ title: "Abortable" })

    const message = runtime.routes.request(`http://127.0.0.1/session/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "exec: long-running" }],
        messageID: "user-abort",
        agent: "pi",
        model: { providerID: "pi", modelID: "virtual" },
      }),
    })
    await turnStarted

    const abort = await runtime.routes.request(`http://127.0.0.1/session/${session.id}/abort`, {
      method: "POST",
    })
    const abortedMessage = await message

    expect(abort.status).toBe(200)
    await expect(abort.json()).resolves.toEqual({ ok: true, status: "cancelled" })
    expect(abortedMessage.status).toBe(200)
    await expect(abortedMessage.json()).resolves.toMatchObject({
      info: {
        id: "user-abort_r",
        role: "assistant",
        error: {
          name: "UnknownError",
          data: { message: "central turn aborted" },
        },
      },
    })
    expect(events.map((event) => event.payload.type)).toEqual([
      "session-info",
      "session-status",
      "session-status",
      "error",
    ])
    expect(events).toContainEqual(expect.objectContaining({
      directory: session.id,
      sessionId: session.id,
      assistantMessageId: "user-abort_r",
      payload: { type: "error", error: "central turn aborted" },
    }))
    await runtime.flushUsage()
    expect(usage.at(-1)).toMatchObject({
      messageId: "user-abort_r",
      settlement: "unavailable",
      status: "stopped",
    })
  })

  /*
   * Pi raises no permission checkpoints, so this pins the ROUTES rather than a
   * gate: a turn runs to completion without one, and `/permission` stays empty.
   *
   * Pi's tools run in `just-bash` over an `InMemoryFs`, so there is nothing to
   * gate. This used to drive a `permission:` prompt prefix that raised a request
   * and blocked the turn; that path is gone, and its absence is what this asserts.
   */
  test("central Pi turns complete without a permission checkpoint", async () => {
    const runtime = createCentralSessionRuntime(services())
    const session = await runtime.createHybridSession({ title: "Permissioned" })
    let sawPermission = false
    runtime.eventHub.subscribeGlobal((event) => {
      if (event.payload.type === "permission.asked") sawPermission = true
    })

    const response = await runtime.routes.request(`http://127.0.0.1/session/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "exec: printf approved" }],
        messageID: "user-permission",
        agent: "pi",
        model: { providerID: "pi", modelID: "virtual" },
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      parts: [expect.objectContaining({ text: "approved" })],
    })
    expect(sawPermission).toBe(false)

    const permissions = await runtime.routes.request("http://127.0.0.1/permission")
    await expect(permissions.json()).resolves.toEqual([])
  })
})
