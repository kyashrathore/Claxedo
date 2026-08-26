import path from "node:path"
import { describe, expect, test } from "bun:test"
import { OpenCodeHarnessAdapter } from "./index"
import { OPENCODE_SUBAGENT_PROVIDER_KIND, opencodeSubagentObservations } from "./subagent"
import { createMemorySubagentAdmissionStore } from "../../subagent-admission"
import { createRuntimeEventHub, type RuntimeEventEnvelope } from "../../runtime-event-hub"
import type { CompatEvent } from "../../compat-events"

function taskPart(input: {
  callID?: string
  status: "pending" | "running" | "completed" | "error"
  metadata?: Record<string, unknown>
  tool?: string
  toolInput?: Record<string, unknown>
}): CompatEvent {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_parent",
      part: {
        id: "prt_task",
        sessionID: "ses_parent",
        messageID: "msg_asst",
        type: "tool",
        callID: input.callID ?? "call_1",
        tool: input.tool ?? "task",
        state: {
          status: input.status,
          input: input.toolInput ?? { description: "Verify child delegation", subagent_type: "general" },
          ...(input.metadata ? { metadata: input.metadata } : {}),
          ...(input.status === "completed" ? { output: "done", title: "task" } : {}),
          time: { start: 1, end: 2 },
        },
      },
      time: 2,
    },
  } as unknown as CompatEvent
}

const engineMetadata = { parentSessionId: "ses_parent", sessionId: "ses_child" }

describe("opencode subagent observations", () => {
  test("reads the engine's own tool-call → child-session correlation", () => {
    expect(opencodeSubagentObservations(taskPart({ status: "running", metadata: engineMetadata }))).toEqual([
      {
        observationId: expect.stringMatching(/^opencode:task:call_1:[0-9a-f]{16}$/) as unknown as string,
        toolCallId: "call_1",
        toolCallRole: "spawn",
        mode: "foreground",
        status: "running",
        subagentType: "general",
        description: "Verify child delegation",
        providerId: "ses_child",
        providerKind: OPENCODE_SUBAGENT_PROVIDER_KIND,
        childSessionId: "ses_child",
        transcript: { kind: "live", ref: "ses_child" },
      },
    ])
  })

  test("maps the tool state onto the subagent lifecycle", () => {
    const status = (state: "pending" | "running" | "completed" | "error") =>
      opencodeSubagentObservations(taskPart({ status: state, metadata: engineMetadata }))[0]?.status
    expect(status("pending")).toBe("pending")
    expect(status("running")).toBe("running")
    expect(status("completed")).toBe("completed")
    expect(status("error")).toBe("failed")
  })

  test("marks a backgrounded delegation", () => {
    expect(opencodeSubagentObservations(taskPart({
      status: "running",
      metadata: { ...engineMetadata, background: true },
    }))[0]?.mode).toBe("background")
  })

  test("re-derives the same observation id for an unchanged republish", () => {
    const first = opencodeSubagentObservations(taskPart({ status: "running", metadata: engineMetadata }))
    const again = opencodeSubagentObservations(taskPart({ status: "running", metadata: engineMetadata }))
    expect(again[0]?.observationId).toBe(first[0]!.observationId)
    const completed = opencodeSubagentObservations(taskPart({ status: "completed", metadata: engineMetadata }))
    expect(completed[0]?.observationId).not.toBe(first[0]!.observationId)
  })

  test("ignores parts the engine has not bound to a child session", () => {
    // A pending `task` part carries no metadata at all, and `task` is not an
    // OpenCode-exclusive tool name — the Cursor SDK rail admits its own. Only
    // the engine-minted parent/child pair identifies this rail.
    expect(opencodeSubagentObservations(taskPart({ status: "pending" }))).toEqual([])
    expect(opencodeSubagentObservations(taskPart({ status: "running", metadata: { parentSessionId: "ses_parent" } }))).toEqual([])
    expect(opencodeSubagentObservations(taskPart({ status: "running", metadata: { sessionId: "ses_child" } }))).toEqual([])
    expect(opencodeSubagentObservations(taskPart({ status: "running", tool: "bash", metadata: engineMetadata }))).toEqual([])
    expect(opencodeSubagentObservations({
      type: "session.idle",
      properties: { sessionID: "ses_parent" },
    } as unknown as CompatEvent)).toEqual([])
  })
})

describe("opencode adapter subagent admission", () => {
  /**
   * The rail end to end at the adapter boundary: the engine publishes a `task`
   * tool part on the parent's event stream, and the turn must leave behind BOTH
   * a durable host row (what `/session/:id/subagents` serves after a reload)
   * and the live `subagent-updated` events the app's registry renders the card
   * from. Before the host producer existed, an OpenCode delegation produced
   * neither, so the `task` renderer resolved zero subagents and drew nothing.
   */
  test("admits and publishes the engine's delegation for the turn", async () => {
    const eventHub = createRuntimeEventHub()
    const subagents = createMemorySubagentAdmissionStore()
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096", { eventHub, subagents })
    const runtime: RuntimeEventEnvelope[] = []
    const unsubscribe = eventHub.subscribeRuntime((event) => runtime.push(event))
    const prev = globalThis.fetch
    const enc = new TextEncoder()
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined

    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      if (req.url.endsWith("/global/event")) {
        return new Response(new ReadableStream<Uint8Array>({ start: (next) => { ctrl = next } }), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }
      if (req.url.endsWith("/session/ses_parent/prompt_async")) {
        queueMicrotask(() => {
          for (const event of [
            taskPart({ status: "running", metadata: engineMetadata }),
            taskPart({ status: "completed", metadata: engineMetadata }),
            {
              type: "message.part.delta",
              properties: {
                sessionID: "ses_parent",
                messageID: "msg_asst",
                partID: "part_text",
                field: "text",
                delta: "delegated",
              },
            },
            { type: "session.idle", properties: { sessionID: "ses_parent" } },
          ]) {
            ctrl?.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`))
          }
        })
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected fetch: ${req.url}`)
    }) as typeof fetch

    try {
      for await (const _ of adapter.sendMessage("ses_parent", {
        parts: [{ type: "text", text: "delegate" }],
        userMessageId: "msg_user",
        assistantMessageId: "msg_asst",
        agent: "build",
        model: { providerID: "opencode", modelID: "big-pickle" },
      }, path.resolve("/tmp/ws"))) {
        // drained for its side effects; the assertions are on the host row and
        // the runtime events, not on the compat stream this test does not own.
      }

      const rows = subagents.records()
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map((row) => row.event.subagentKey)).size).toBe(1)
      expect(rows.map((row) => row.event.revision)).toEqual([1, 2])
      expect(rows.map((row) => row.event.status)).toEqual(["running", "completed"])
      expect(rows.every((row) => row.parentSessionId === "ses_parent" && row.published)).toBe(true)

      const published = runtime.filter((event) => event.payload.type === "subagent-updated")
      expect(published).toHaveLength(2)
      expect(published.every((event) => event.sessionId === "ses_parent" && event.directory === path.resolve("/tmp/ws"))).toBe(true)
      expect(published[0]?.payload).toMatchObject({
        type: "subagent-updated",
        toolCallId: "call_1",
        toolCallRole: "spawn",
        childSessionId: "ses_child",
        transcript: { kind: "live", ref: "ses_child" },
      })
    } finally {
      unsubscribe()
      globalThis.fetch = prev
    }
  })

  test("streams the turn unchanged when no host store backs the adapter", async () => {
    const eventHub = createRuntimeEventHub()
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096", { eventHub })
    const runtime: RuntimeEventEnvelope[] = []
    const unsubscribe = eventHub.subscribeRuntime((event) => runtime.push(event))
    const prev = globalThis.fetch
    const enc = new TextEncoder()
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined

    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      if (req.url.endsWith("/global/event")) {
        return new Response(new ReadableStream<Uint8Array>({ start: (next) => { ctrl = next } }), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }
      if (req.url.endsWith("/session/ses_parent/prompt_async")) {
        queueMicrotask(() => {
          ctrl?.enqueue(enc.encode(`data: ${JSON.stringify(taskPart({ status: "completed", metadata: engineMetadata }))}\n\n`))
          ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({
            type: "message.part.delta",
            properties: { sessionID: "ses_parent", messageID: "msg_asst", partID: "p", field: "text", delta: "ok" },
          })}\n\n`))
          ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_parent" } })}\n\n`))
        })
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected fetch: ${req.url}`)
    }) as typeof fetch

    try {
      const compat: string[] = []
      for await (const event of adapter.sendMessage("ses_parent", {
        parts: [{ type: "text", text: "delegate" }],
        userMessageId: "msg_user",
        assistantMessageId: "msg_asst",
        agent: "build",
        model: { providerID: "opencode", modelID: "big-pickle" },
      }, path.resolve("/tmp/ws"))) {
        compat.push(event.type)
      }
      expect(compat).toContain("message.part.updated")
      expect(compat).toContain("message.completed")
      expect(runtime.some((event) => event.payload.type === "subagent-updated")).toBe(false)
    } finally {
      unsubscribe()
      globalThis.fetch = prev
    }
  })
})
