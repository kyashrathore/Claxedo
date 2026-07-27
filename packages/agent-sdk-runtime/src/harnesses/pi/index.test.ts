import { describe, expect, test } from "bun:test"
import { getModel, createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai"
import type { StreamFn } from "@mariozechner/pi-agent-core"
import { PiHarnessAdapter } from "./index"
import { createRuntimeEventHub, type RuntimeEventEnvelope } from "../../runtime-event-hub"
import { createVirtualSessionEnv, type PromptInput, type SessionEnvFactoryInput } from "../../index"
import type { AgentProcessDescriptor, AgentProcessObserver } from "../../process-observer"

function prompt(input: Partial<PromptInput> = {}): PromptInput {
  return {
    parts: [{ type: "text", text: "exec: printf hi > note.txt && cat note.txt" }],
    assistantMessageId: "assistant-1",
    userMessageId: "user-1",
    agent: "pi",
    model: { providerID: "pi", modelID: "virtual" },
    ...input,
  }
}

async function collect<T>(input: AsyncIterable<T>) {
  const out: T[] = []
  for await (const event of input) out.push(event)
  return out
}

async function nextEvent<T extends { type: string }>(iterator: AsyncIterator<T>, type: string) {
  while (true) {
    const next = await iterator.next()
    if (next.done) throw new Error(`expected ${type}`)
    if (next.value.type === type) return next.value
  }
}

describe("PiHarnessAdapter", () => {
  test("creates and runs a directory-less virtual turn", async () => {
    const adapter = new PiHarnessAdapter()
    const session = await adapter.createSession(undefined, "Hybrid")

    const events = await collect(adapter.sendMessage(session.id, prompt(), undefined))

    expect(events.map((event) => event.type)).toEqual([
      "message.updated",
      "message.part.updated",
      "session-status",
      "text-delta",
      "session-status",
      "finish",
    ])
    expect(events).toContainEqual({ type: "text-delta", delta: "hi" })
    expect(await adapter.listSessions(undefined)).toMatchObject([{ id: session.id, title: "Hybrid" }])
    expect(await adapter.getMessages(session.id, undefined)).toMatchObject([
      { info: { id: "user-1", role: "user" }, parts: [{ text: "exec: printf hi > note.txt && cat note.txt" }] },
      { info: { id: "assistant-1", role: "assistant" }, parts: [{ text: "hi" }] },
    ])
  })

  test("attributes in-process model and SessionEnv command lifecycles without shell text", async () => {
    const sentinel = "pi-observer-sentinel"
    const descriptors: AgentProcessDescriptor[] = []
    const exits: unknown[] = []
    const processObserver: AgentProcessObserver = {
      register(descriptor) {
        descriptors.push(descriptor)
        return {
          update: () => undefined,
          exit: (event) => exits.push(event),
        }
      },
    }
    const adapter = new PiHarnessAdapter({ processObserver })
    const session = await adapter.createSession("/safe/workspace")

    await collect(adapter.sendMessage(session.id, prompt({
      parts: [{ type: "text", text: `exec: printf ${sentinel}` }],
    }), "/safe/workspace"))
    await adapter.deleteSession(session.id, "/safe/workspace")

    expect(descriptors.map((descriptor) => [descriptor.role, descriptor.locality])).toEqual([
      ["harness", "in-process"],
      ["tool", "in-process"],
    ])
    expect(descriptors[1]?.parentOwnerId).toBe(descriptors[0]?.ownerId)
    expect(JSON.stringify(descriptors)).not.toContain(sentinel)
    expect(exits).toHaveLength(2)
  })

  test("late-binds the session environment with explicit placement", async () => {
    const placements: SessionEnvFactoryInput[] = []
    const adapter = new PiHarnessAdapter({
      defaultPlacement: {
        mode: "local",
        host: "workspace",
        directory: "/workspace",
        workspaceId: "ws_1",
        toolSandbox: { kind: "virtual", id: "proc_1" },
      },
      createEnv: async (input) => {
        placements.push(input)
        return createVirtualSessionEnv()
      },
    })

    const session = await adapter.createSession("/workspace", "Local workspace")

    expect(placements).toEqual([{
      sessionId: session.id,
      mode: "local",
      host: "workspace",
      directory: "/workspace",
      workspaceId: "ws_1",
      toolSandbox: { kind: "virtual", id: "proc_1" },
    }])
  })

  test("resolves placement per session with directory context", async () => {
    const resolverInputs: Array<{ sessionId: string; directory: string | undefined }> = []
    const placements: SessionEnvFactoryInput[] = []
    const adapter = new PiHarnessAdapter({
      defaultPlacement: async (input) => {
        resolverInputs.push(input)
        return {
          mode: "cloud",
          host: "workspace",
          directory: input.directory,
          workspaceId: `ws-${input.sessionId}`,
          toolSandbox: { kind: "virtual", id: `ws-${input.sessionId}` },
        }
      },
      createEnv: async (input) => {
        placements.push(input)
        return createVirtualSessionEnv()
      },
    })

    const session = await adapter.createSession("/cloud/workspace", "Cloud workspace")

    expect(resolverInputs).toEqual([{ sessionId: session.id, directory: "/cloud/workspace" }])
    expect(placements).toEqual([{
      sessionId: session.id,
      mode: "cloud",
      host: "workspace",
      directory: "/cloud/workspace",
      workspaceId: `ws-${session.id}`,
      toolSandbox: { kind: "virtual", id: `ws-${session.id}` },
    }])
  })

  test("falls back to central virtual placement when no placement is configured", async () => {
    const placements: SessionEnvFactoryInput[] = []
    const adapter = new PiHarnessAdapter({
      createEnv: async (input) => {
        placements.push(input)
        return createVirtualSessionEnv()
      },
    })

    const session = await adapter.createSession(undefined, "Hybrid")

    expect(placements).toEqual([{
      sessionId: session.id,
      mode: "hybrid",
      host: "central",
      toolSandbox: { kind: "virtual", id: session.id },
    }])
  })

  test("does not rebind placement for an existing session", async () => {
    const placements: SessionEnvFactoryInput[] = []
    const adapter = new PiHarnessAdapter({
      createEnv: async (input) => {
        placements.push(input)
        return createVirtualSessionEnv()
      },
    })

    await adapter.bindSession({
      id: "session_1",
      title: "Original",
      placement: {
        mode: "hybrid",
        host: "central",
        toolSandbox: { kind: "virtual", id: "first" },
      },
    })
    await adapter.bindSession({
      id: "session_1",
      title: "Renamed",
      placement: {
        mode: "local",
        host: "workspace",
        workspaceId: "ws_2",
        toolSandbox: { kind: "virtual", id: "second" },
      },
    })

    expect(placements).toEqual([{
      sessionId: "session_1",
      mode: "hybrid",
      host: "central",
      toolSandbox: { kind: "virtual", id: "first" },
    }])
    expect(await adapter.listSessions(undefined)).toMatchObject([{ id: "session_1", title: "Renamed" }])
  })

  test("publishes canonical runtime events to the event hub", async () => {
    const eventHub = createRuntimeEventHub()
    const runtimeEvents: RuntimeEventEnvelope[] = []
    eventHub.subscribeRuntime((event) => runtimeEvents.push(event))
    const adapter = new PiHarnessAdapter({ eventHub })
    const session = await adapter.createSession(undefined, "Hybrid")

    await collect(adapter.sendMessage(session.id, prompt(), undefined))

    expect(runtimeEvents.map((event) => event.payload.type)).toEqual([
      "session-status",
      "text-delta",
      "session-status",
      "finish",
    ])
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      directory: session.id,
      sessionId: session.id,
      assistantMessageId: "assistant-1",
      payload: { type: "finish", sessionId: session.id },
    }))
  })

  /*
   * Pi has no permission path, and the capability says so.
   *
   * Its tools run in `just-bash` over an `InMemoryFs` (`createVirtualSessionEnv`),
   * so a command mutates a JavaScript object and there is nothing to gate. The
   * two port members stay because the contract requires them; both are inert, and
   * `respondPermission` must tolerate an id it never issued rather than throw.
   */
  test("raises no permission requests, and answers none", async () => {
    const adapter = new PiHarnessAdapter()
    const session = await adapter.createSession(undefined, "Hybrid")
    const events = await collect(adapter.sendMessage(session.id, prompt({
      parts: [{ type: "text", text: "exec: printf ran" }],
    }), undefined))

    expect(events.map((event) => event.type)).not.toContain("permission.asked")
    expect(events).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "ran" }))
    expect(await adapter.listPermissions(undefined)).toEqual([])
    await adapter.respondPermission(`${session.id}:perm_1`, "allow_once", undefined)
    expect(adapter.readHarnessCapabilities(session.id).permissions).toBe(false)
  })

  /*
   * `permission:` is ordinary prompt text now.
   *
   * It used to be a magic prefix that raised a request and blocked the turn on an
   * answer — a gate that only existed when the prompt happened to opt into it,
   * while every other prompt ran unchecked. Pinned so the prefix cannot quietly
   * regain meaning.
   */
  test("a prompt beginning with permission: is not a checkpoint", async () => {
    const adapter = new PiHarnessAdapter()
    const session = await adapter.createSession(undefined, "Hybrid")
    const iterator = adapter.sendMessage(session.id, prompt({
      // One token: `printf` renders only the format operand, so a spaced string
      // would assert on shell behaviour rather than on the prefix being inert.
      parts: [{ type: "text", text: "exec: printf permission:bash" }],
    }), undefined)[Symbol.asyncIterator]()

    const rest = []
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) rest.push(event)

    expect(rest.map((event) => event.type)).not.toContain("permission.asked")
    expect(rest).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "permission:bash" }))
  })

  test("runs a real model turn through the configured backend", async () => {
    const model = getModel("openai-codex", "gpt-5.1-codex-mini")
    const streamFn: StreamFn = (streamModel, _context, _options) => {
      const stream = createAssistantMessageEventStream()
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        api: streamModel.api,
        provider: streamModel.provider,
        model: streamModel.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      }
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message })
        stream.push({ type: "text_start", contentIndex: 0, partial: message })
        stream.push({ type: "text_delta", contentIndex: 0, delta: "hello ", partial: message })
        stream.push({ type: "text_delta", contentIndex: 0, delta: "from codex", partial: message })
        const done: AssistantMessage = {
          ...message,
          content: [{ type: "text", text: "hello from codex" }],
        }
        stream.push({ type: "text_end", contentIndex: 0, content: "hello from codex", partial: done })
        stream.push({ type: "done", reason: "stop", message: done })
        stream.end(done)
      })
      return stream
    }
    const adapter = new PiHarnessAdapter({
      modelBackend: () => ({
        model,
        getApiKey: () => "test-key",
        streamFn,
      }),
    })
    const session = await adapter.createSession(undefined, "Model")
    const events = await collect(adapter.sendMessage(session.id, prompt({
      parts: [{ type: "text", text: "say hello" }],
    }), undefined))

    const deltas = events.filter((event) => event.type === "text-delta")
    expect(deltas).toEqual([
      { type: "text-delta", delta: "hello " },
      { type: "text-delta", delta: "from codex" },
    ])
    expect(events.at(-1)).toEqual({ type: "finish", sessionId: session.id })
    expect(await adapter.getMessages(session.id, undefined)).toMatchObject([
      { info: { id: "user-1", role: "user" } },
      { info: { id: "assistant-1", role: "assistant" }, parts: [{ text: "hello from codex" }] },
    ])
  })

  test("model turn failures surface as error events, not silent echoes", async () => {
    const model = getModel("openai-codex", "gpt-5.1-codex-mini")
    const streamFn: StreamFn = (streamModel, _context, _options) => {
      const stream = createAssistantMessageEventStream()
      const failed: AssistantMessage = {
        role: "assistant",
        content: [],
        api: streamModel.api,
        provider: streamModel.provider,
        model: streamModel.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "provider exploded",
        timestamp: Date.now(),
      }
      queueMicrotask(() => {
        stream.push({ type: "start", partial: failed })
        stream.push({ type: "error", reason: "error", error: failed })
        stream.end(failed)
      })
      return stream
    }
    const adapter = new PiHarnessAdapter({
      modelBackend: () => ({ model, getApiKey: () => "test-key", streamFn }),
    })
    const session = await adapter.createSession(undefined, "Model")
    const events = await collect(adapter.sendMessage(session.id, prompt({
      parts: [{ type: "text", text: "say hello" }],
    }), undefined))

    expect(events.some((event) => event.type === "error")).toBe(true)
    const statuses = events.filter((event) => event.type === "session-status")
    expect(statuses.at(-1)).toMatchObject({ status: "error" })
  })

  test("passes each session's exact selected model to the resolver", async () => {
    const resolved: Array<{ sessionId: string; model?: { providerID: string; modelID: string } }> = []
    const adapter = new PiHarnessAdapter({
      modelBackend: (input) => {
        resolved.push(input)
        return undefined
      },
    })
    await adapter.bindSession({ id: "session-openai" })
    await adapter.bindSession({ id: "session-anthropic" })
    await adapter.updateSessionConfig("session-openai", {
      model: { providerID: "openai", modelID: "gpt-4.1" },
    }, undefined)
    await adapter.updateSessionConfig("session-anthropic", {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    }, undefined)

    const [openaiEvents, anthropicEvents] = await Promise.all([
      collect(adapter.sendMessage("session-openai", prompt({ parts: [{ type: "text", text: "hello" }] }), undefined)),
      collect(adapter.sendMessage("session-anthropic", prompt({ parts: [{ type: "text", text: "hello" }] }), undefined)),
    ])

    expect(resolved).toEqual(expect.arrayContaining([
      { sessionId: "session-openai", model: { providerID: "openai", modelID: "gpt-4.1" } },
      { sessionId: "session-anthropic", model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" } },
    ]))
    for (const events of [openaiEvents, anthropicEvents]) {
      expect(events.some((event) => event.type === "error")).toBe(true)
      expect(events.some((event) => event.type === "text-delta")).toBe(false)
    }
  })

  test("legacy virtual sessions fail with new-session guidance instead of echoing the prompt", async () => {
    const adapter = new PiHarnessAdapter({ modelBackend: () => undefined })
    await adapter.bindSession({ id: "legacy-virtual" })

    const events = await collect(adapter.sendMessage("legacy-virtual", prompt({
      parts: [{ type: "text", text: "hello" }],
    }), undefined))

    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.stringContaining("Start a new Pi session"),
    }))
    expect(events.some((event) => event.type === "text-delta")).toBe(false)
  })

  test("rejects a backend that substitutes a different model", async () => {
    const adapter = new PiHarnessAdapter({
      modelBackend: () => ({
        model: getModel("openai", "gpt-4.1"),
        getApiKey: () => "test-key",
      }),
    })
    await adapter.bindSession({ id: "session-a" })
    await adapter.updateSessionConfig("session-a", {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    }, undefined)

    const events = await collect(adapter.sendMessage("session-a", prompt({
      parts: [{ type: "text", text: "hello" }],
    }), undefined))

    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.stringContaining("backend resolved openai/gpt-4.1"),
    }))
    expect(events.some((event) => event.type === "text-delta")).toBe(false)
  })
})
