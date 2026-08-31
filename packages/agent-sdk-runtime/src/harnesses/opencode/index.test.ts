import path from "node:path"
import { describe, expect, test } from "bun:test"
import { AgentMessagePageError } from "../../message-page"
import { fakeGlobalFetch, internalsOf } from "../../test-utils/class-internals"
import { createProcessLifecycle } from "../shared/process-lifecycle"
import { OpenCodeHarnessAdapter, spawnEnv, type OpenCodeRequestFn } from "./index"

function prompt() {
  return {
    parts: [{ type: "text", text: "hello" }],
    userMessageId: "msg-user",
    assistantMessageId: "msg-assistant",
    agent: "build",
    model: {
      providerID: "opencode",
      modelID: "model",
    },
  }
}

describe("OpenCodeHarnessAdapter sendMessage", () => {
  test("requires a workspace directory before proxying session requests", async () => {
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096")

    await expect(adapter.listSessions(undefined as never)).rejects.toThrow("workspace directory is required")
  })

  test("does not pass workspace-runtime relay auth env to spawned opencode", () => {
    const env = spawnEnv({
      CLAXEDO_WR_RELAY_HOST_PUBLIC_KEY_JWK: "{}",
      CLAXEDO_WR_RELAY_JWT_ALG: "EdDSA",
      CLAXEDO_RELAY_JWKS_URL: "https://relay.test/.well-known/jwks.json",
      CLAXEDO_RELAY_HOST_VERIFY_PEM: "pem",
      WORKSPACE_RUNTIME_CONFIG_TOKEN: "config-token",
      CLAXEDO_WR_TRUSTED_DIRECT_TOKEN: "direct-token",
      CLAXEDO_CONTROL_PLANE_URL: "https://control.test",
      CLAXEDO_CONTROL_PLANE_JWKS_URL: "https://control.test/.well-known/jwks.json",
      CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN: "installation-secret",
      OPENCODE_CONFIG_DIR: path.resolve("/tmp/opencode-config"),
    })

    expect(env.CLAXEDO_WR_RELAY_HOST_PUBLIC_KEY_JWK).toBeUndefined()
    expect(env.CLAXEDO_WR_RELAY_JWT_ALG).toBeUndefined()
    expect(env.CLAXEDO_RELAY_JWKS_URL).toBeUndefined()
    expect(env.CLAXEDO_RELAY_HOST_VERIFY_PEM).toBeUndefined()
    expect(env.WORKSPACE_RUNTIME_CONFIG_TOKEN).toBeUndefined()
    expect(env.CLAXEDO_WR_TRUSTED_DIRECT_TOKEN).toBeUndefined()
    expect(env.CLAXEDO_CONTROL_PLANE_URL).toBeUndefined()
    expect(env.CLAXEDO_CONTROL_PLANE_JWKS_URL).toBeUndefined()
    expect(env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN).toBeUndefined()
    expect(env.OPENCODE_CONFIG_DIR).toBe(path.resolve("/tmp/opencode-config"))
  })

  test("posts to the async message route and emits streamed assistant content before completion", async () => {
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096")
    const prev = globalThis.fetch
    const seen: Array<{ method: string; path: string; directory: string | null; body: unknown }> = []
    const enc = new TextEncoder()
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined

    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(req.url)
      seen.push({
        method: req.method,
        path: url.pathname,
        directory: req.headers.get("x-opencode-directory"),
        body: req.method === "POST" ? await req.json() : undefined,
      })
      if (url.pathname === "/global/event") {
        return new Response(new ReadableStream<Uint8Array>({
          start(next) {
            ctrl = next
          },
        }), { status: 200, headers: { "Content-Type": "text/event-stream" } })
      }
      if (url.pathname === "/session/s1/prompt_async" && req.method === "POST") {
        queueMicrotask(() => {
          ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({
            type: "message.part.updated",
            properties: {
              sessionID: "s1",
              part: { id: "part-real", sessionID: "s1", messageID: "msg-assistant", type: "text", text: "done" },
            },
          })}\n\n`))
          ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({
            type: "session.idle",
            properties: { sessionID: "s1" },
          })}\n\n`))
        })
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected fetch: ${req.url}`)
    }) as typeof fetch

    try {
      const events = []
      for await (const event of adapter.sendMessage("s1", prompt(), path.resolve("/work"))) {
        events.push(event)
      }

      expect(seen).toEqual([
        { method: "GET", path: "/global/event", directory: path.resolve("/work"), body: undefined },
        {
          method: "POST",
          path: "/session/s1/prompt_async",
          directory: path.resolve("/work"),
          body: {
            parts: [{ type: "text", text: "hello" }],
            messageID: "msg-user",
            agent: "build",
            model: { providerID: "opencode", modelID: "model" },
          },
        },
      ])
      expect(events).toContainEqual(expect.objectContaining({
        type: "message.part.updated",
        properties: expect.objectContaining({
          part: expect.objectContaining({
            id: "part-real",
            messageID: "msg-assistant",
            text: "done",
          }),
        }),
      }))
      expect(events.at(-2)).toMatchObject({ type: "session.idle" })
      expect(events.at(-1)).toMatchObject({ type: "message.completed" })
    } finally {
      globalThis.fetch = prev
    }
  })

  test("treats patch-only upstream completions as no visible assistant content", async () => {
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096")
    const prev = globalThis.fetch
    const enc = new TextEncoder()
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined

    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(req.url)
      if (url.pathname === "/global/event") {
        return new Response(new ReadableStream<Uint8Array>({
          start(next) {
            ctrl = next
          },
        }), { status: 200, headers: { "Content-Type": "text/event-stream" } })
      }
      if (url.pathname === "/session/s1/prompt_async" && req.method === "POST") {
        queueMicrotask(() => {
          ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({
            type: "message.part.updated",
            properties: {
              sessionID: "s1",
              part: {
                id: "part-patch",
                sessionID: "s1",
                messageID: "msg-assistant",
                type: "patch",
                files: [path.resolve("/work/.workspace-runtime/runtime-config/apply-status.json")],
              },
            },
          })}\n\n`))
          ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({
            type: "session.idle",
            properties: { sessionID: "s1" },
          })}\n\n`))
        })
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected fetch: ${req.url}`)
    }) as typeof fetch

    try {
      const events = []
      for await (const event of adapter.sendMessage("s1", prompt(), path.resolve("/work"))) {
        events.push(event)
      }

      expect(events).toContainEqual(expect.objectContaining({
        type: "session.error",
        properties: expect.objectContaining({
          error: expect.objectContaining({
            data: expect.objectContaining({
              message: expect.stringContaining("without visible assistant content"),
            }),
          }),
        }),
      }))
      expect(events.some((event) => event.type === "message.completed")).toBe(false)
    } finally {
      globalThis.fetch = prev
    }
  })

  test("requires visible content for each streamed prompt", async () => {
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096")
    const prev = globalThis.fetch
    let calls = 0
    const enc = new TextEncoder()
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined

    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(req.url)
      if (url.pathname === "/global/event") {
        return new Response(new ReadableStream<Uint8Array>({
          start(next) {
            ctrl = next
          },
        }), { status: 200, headers: { "Content-Type": "text/event-stream" } })
      }
      if (url.pathname === "/session/s1/prompt_async" && req.method === "POST") {
        calls += 1
        queueMicrotask(() => {
          ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({
            type: "message.part.updated",
            properties: {
              sessionID: "s1",
              part: { id: `step-start-${calls}`, sessionID: "s1", messageID: `msg-user-${calls}_r`, type: "text", text: `answer-${calls}` },
            },
          })}\n\n`))
          ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({
            type: "session.idle",
            properties: { sessionID: "s1" },
          })}\n\n`))
        })
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected fetch: ${req.url}`)
    }) as typeof fetch

    try {
      const first = []
      for await (const event of adapter.sendMessage("s1", {
        ...prompt(),
        userMessageId: "msg-user-1",
        assistantMessageId: "msg-user-1_r",
      }, path.resolve("/work"))) {
        first.push(event)
      }
      const second = []
      for await (const event of adapter.sendMessage("s1", {
        ...prompt(),
        userMessageId: "msg-user-2",
        assistantMessageId: "msg-user-2_r",
      }, path.resolve("/work"))) {
        second.push(event)
      }

      expect(first.find((event) =>
        event.type === "message.part.updated" && event.properties.part.messageID === "msg-user-1_r"
      )).toMatchObject({
        properties: { part: { id: "step-start-1", messageID: "msg-user-1_r", text: "answer-1" } },
      })
      expect(second.find((event) =>
        event.type === "message.part.updated" && event.properties.part.messageID === "msg-user-2_r"
      )).toMatchObject({
        properties: { part: { id: "step-start-2", messageID: "msg-user-2_r", text: "answer-2" } },
      })
    } finally {
      globalThis.fetch = prev
    }
  })
})

describe("OpenCodeHarnessAdapter injected-request transport", () => {
  test("forwards message page parameters and preserves the upstream cursor", async () => {
    const seen: Array<{ pathname: string; view: string | null; limit: string | null; before: string | null; directory: string | null }> = []
    const cursor = "opaque+/cursor== with spaces"
    const adapter = new OpenCodeHarnessAdapter(undefined, {
      request: async (request) => {
        const url = new URL(request.url)
        seen.push({
          pathname: url.pathname,
          view: url.searchParams.get("view"),
          limit: url.searchParams.get("limit"),
          before: url.searchParams.get("before"),
          directory: request.headers.get("x-opencode-directory"),
        })
        return Response.json(
          [{ info: { id: "msg-1", role: "user" }, parts: [] }],
          { headers: { "X-Next-Cursor": cursor } },
        )
      },
    })

    await expect(adapter.getMessagePage("s1", { limit: 80, before: cursor }, "/work"))
      .resolves.toEqual({
        messages: [{ info: { id: "msg-1", role: "user" }, parts: [] }],
        nextCursor: cursor,
      })
    expect(seen).toEqual([{
      pathname: "/session/s1/message",
      view: null,
      limit: "80",
      before: cursor,
      directory: path.resolve("/work"),
    }])
  })

  test("forwards the authoritative latest-turn view without a numeric page", async () => {
    let seen: URL | undefined
    const adapter = new OpenCodeHarnessAdapter(undefined, {
      request: async (request) => {
        seen = new URL(request.url)
        return Response.json(
          [{ info: { id: "user-2", role: "user" }, parts: [] }],
          { headers: { "X-Next-Cursor": "before-user-2" } },
        )
      },
    })

    await expect(adapter.getMessagePage("s1", { view: "latest-turn" }, "/work"))
      .resolves.toEqual({
        messages: [{ info: { id: "user-2", role: "user" }, parts: [] }],
        nextCursor: "before-user-2",
      })
    expect(seen?.searchParams.get("view")).toBe("latest-turn")
    expect(seen?.searchParams.get("limit")).toBeNull()
    expect(seen?.searchParams.get("before")).toBeNull()
  })

  test("forwards the bounded latest-surface view without a numeric page", async () => {
    let seen: URL | undefined
    const adapter = new OpenCodeHarnessAdapter(undefined, {
      request: async (request) => {
        seen = new URL(request.url)
        return Response.json([{ info: { id: "assistant-final", role: "assistant" }, parts: [] }])
      },
    })

    await expect(adapter.getMessagePage("s1", { view: "latest-surface" }, "/work"))
      .resolves.toEqual({ messages: [{ info: { id: "assistant-final", role: "assistant" }, parts: [] }] })
    expect(seen?.searchParams.get("view")).toBe("latest-surface")
    expect(seen?.searchParams.get("limit")).toBeNull()
    expect(seen?.searchParams.get("before")).toBeNull()
  })

  test("omits terminal message page cursors and throws on upstream failures", async () => {
    const requests: URL[] = []
    let response = Response.json([])
    const adapter = new OpenCodeHarnessAdapter(undefined, {
      request: async (request) => {
        requests.push(new URL(request.url))
        return response
      },
    })

    await expect(adapter.getMessagePage("s1", { limit: 2 }, "/work"))
      .resolves.toEqual({ messages: [] })
    expect(requests[0]?.searchParams.get("before")).toBeNull()

    response = new Response("invalid cursor", { status: 400 })
    const failure = await adapter.getMessagePage("s1", { limit: 2, before: "bad" }, "/work")
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AgentMessagePageError)
    expect(failure).toMatchObject({
      name: "AgentMessagePageError",
      message: "Failed to get message page: 400",
      status: 400,
    })
  })

  test("routes session list/create/status through the injected handler — no spawn, no network", async () => {
    const seen: Array<{ method: string; path: string; directory: string | null; body: string }> = []
    const handler: OpenCodeRequestFn = async (req) => {
      const url = new URL(req.url)
      const body = req.body ? await req.text() : ""
      seen.push({
        method: req.method,
        path: url.pathname,
        directory: req.headers.get("x-opencode-directory"),
        body,
      })
      if (url.pathname === "/session" && req.method === "GET") {
        return Response.json([{ id: "ses_a" }])
      }
      if (url.pathname === "/session" && req.method === "POST") {
        return Response.json({ id: "ses_new" })
      }
      if (url.pathname === "/session/status") {
        return Response.json({ active: { type: "idle" } })
      }
      return new Response("unexpected", { status: 500 })
    }

    // No URL, only an injected handler — the process must never be consulted.
    // Fail loudly if any real network is attempted.
    const prev = globalThis.fetch
    globalThis.fetch = fakeGlobalFetch(async () => {
      throw new Error("network must not be used in injected mode")
    })
    try {
      const adapter = new OpenCodeHarnessAdapter(undefined, { request: handler })

      expect(await adapter.listSessions(path.resolve("/work"))).toEqual([{ id: "ses_a" } as never])
      expect(await adapter.createSession(path.resolve("/work"), "Title")).toEqual({ id: "ses_new" })
      const status = await adapter.getStatusSnapshot(path.resolve("/work"))
      expect(await status.json()).toEqual({ active: { type: "idle" } })

      expect(seen).toEqual([
        { method: "GET", path: "/session", directory: path.resolve("/work"), body: "" },
        { method: "POST", path: "/session", directory: path.resolve("/work"), body: JSON.stringify({ title: "Title" }) },
        { method: "GET", path: "/session/status", directory: path.resolve("/work"), body: "" },
      ])

      // getServerUrl must fail in injected mode — callers use getRequestFn.
      await expect(adapter.getServerUrl()).rejects.toThrow("injected-request mode")
    } finally {
      globalThis.fetch = prev
    }
  })

  test("injected handler carrying a request body works on Node (duplex)", async () => {
    let received = ""
    const handler: OpenCodeRequestFn = async (req) => {
      received = await req.text()
      return Response.json({ id: "ses_body" })
    }
    const adapter = new OpenCodeHarnessAdapter(undefined, { request: handler })
    await adapter.createSession(path.resolve("/work"), "Body Session")
    expect(received).toBe(JSON.stringify({ title: "Body Session" }))
  })

  test("passes a requested deterministic Session id to OpenCode", async () => {
    let received = ""
    const adapter = new OpenCodeHarnessAdapter(undefined, {
      request: async (request) => {
        received = await request.text()
        return Response.json({ id: "ses_wgrun_run_1" })
      },
    })

    await expect(adapter.createSession(path.resolve("/work"), "Stable", "ses_wgrun_run_1"))
      .resolves.toEqual({ id: "ses_wgrun_run_1" })
    expect(received).toBe(JSON.stringify({ id: "ses_wgrun_run_1", title: "Stable" }))
  })

  test("does not delete an existing target session while preparing a handoff", async () => {
    const methods: string[] = []
    const adapter = new OpenCodeHarnessAdapter(undefined, {
      request: async (request) => {
        methods.push(request.method)
        const url = new URL(request.url)
        if (url.pathname === "/session/ses_existing" && request.method === "GET") {
          return Response.json({ id: "ses_existing", title: "Prior target" })
        }
        return new Response("unexpected", { status: 500 })
      },
    })

    await expect(adapter.createHandoffSession(path.resolve("/work"), "Replacement", "ses_existing"))
      .rejects.toThrow("target session ses_existing already exists")
    expect(methods).toEqual(["GET"])
  })

  test("sends messages through the injected handler", async () => {
    let promptSeen = false
    const enc = new TextEncoder()
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
    const handler: OpenCodeRequestFn = async (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/global/event") {
        return new Response(new ReadableStream<Uint8Array>({
          start(next) {
            ctrl = next
          },
        }), { status: 200, headers: { "Content-Type": "text/event-stream" } })
      }
      if (url.pathname === "/session/s1/prompt_async") {
        promptSeen = true
        queueMicrotask(() => {
          ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({
            type: "message.part.updated",
            properties: {
              sessionID: "s1",
              part: { id: "part-assistant", sessionID: "s1", messageID: "msg-assistant", type: "text", text: "done" },
            },
          })}\n\n`))
          ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({
            type: "session.idle",
            properties: { sessionID: "s1" },
          })}\n\n`))
        })
        return new Response(null, { status: 204 })
      }
      return new Response("unexpected", { status: 500 })
    }

    const adapter = new OpenCodeHarnessAdapter(undefined, { request: handler })
    const events = []
    for await (const event of adapter.sendMessage("s1", prompt(), path.resolve("/work"))) {
      events.push(event)
    }

    expect(promptSeen).toBe(true)
    expect(events.some((event) => event.type === "session.idle")).toBe(true)
    expect(events.some((event) => event.type === "message.part.updated")).toBe(true)
  })
})

/**
 * A spawn-mode server backed by the REAL shared lifecycle, with timers
 * injected and nothing actually spawned.
 *
 * The question under test is whether the prompt stream keeps the lifecycle
 * open, so a hand-written lease counter would only restate the answer — the
 * lifecycle itself has to be the one deciding whether the child dies.
 */
function spawnedServerDouble(url: string) {
  const timers: Array<{ id: number; fn: () => void }> = []
  let nextTimer = 1
  const stopped: number[] = []
  const lifecycle = createProcessLifecycle<{ url: string }>({
    idleGraceMs: 30_000,
    start: async () => ({ url }),
    stop: ({ generation }) => { stopped.push(generation) },
    setTimeout: (fn) => {
      const id = nextTimer++
      timers.push({ id, fn })
      return id
    },
    clearTimeout: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle)
      if (index >= 0) timers.splice(index, 1)
    },
  })
  return {
    lifecycle,
    stopped,
    /** Let the idle grace elapse, as the event loop eventually would. */
    fireIdle() {
      for (const timer of timers.splice(0)) timer.fn()
    },
    server: {
      mode: "spawned" as const,
      get hasProcess() { return lifecycle.state() === "ready" },
      async ensureServer() { return (await lifecycle.ensure()).url },
      async ensureConnection() { return { url: (await lifecycle.ensure()).url } },
      async acquire() {
        const { handle, lease } = await lifecycle.acquire()
        return { connection: { url: handle.url }, lease }
      },
      restartSpawnedProcess: () => false,
      dispose() {},
    },
  }
}

describe("OpenCodeHarnessAdapter prompt-stream lifecycle", () => {
  test("holds the spawned server open across a silent gap in the turn", async () => {
    // A tool call that runs longer than the idle grace produces no traffic at
    // all. Without a lease spanning the WHOLE stream, the countdown armed by
    // the opening request expires mid-turn and kills a healthy child — the
    // same defect the ACP adapter leases its prompt turn to avoid.
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096")
    const backing = spawnedServerDouble("http://127.0.0.1:4096")
    internalsOf<{ server: unknown }>(adapter).server = backing.server

    const enc = new TextEncoder()
    let emit: ((chunk: string) => void) | undefined
    let announcePost: (() => void) | undefined
    const posted = new Promise<void>((resolve) => { announcePost = resolve })
    const prev = globalThis.fetch
    globalThis.fetch = fakeGlobalFetch(async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(req.url)
      if (url.pathname === "/global/event") {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            emit = (chunk) => controller.enqueue(enc.encode(chunk))
          },
        }), { status: 200, headers: { "Content-Type": "text/event-stream" } })
      }
      if (url.pathname === "/session/s1/prompt_async") {
        announcePost?.()
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected fetch: ${req.url}`)
    })

    try {
      const events: Array<{ type: string }> = []
      const draining = (async () => {
        for await (const event of adapter.sendMessage("s1", prompt(), path.resolve("/work"))) {
          events.push(event as { type: string })
        }
      })()
      await posted

      // The turn is live and silent. The idle grace elapses here.
      expect(backing.lifecycle.activeLeases()).toBe(1)
      backing.fireIdle()
      await Promise.resolve()
      await Promise.resolve()
      expect(backing.stopped).toEqual([])
      expect(backing.lifecycle.state()).toBe("ready")

      emit!(`data: ${JSON.stringify({
        type: "message.part.updated",
        properties: {
          sessionID: "s1",
          part: { id: "part-1", sessionID: "s1", messageID: "msg-assistant", type: "text", text: "done" },
        },
      })}\n\n`)
      emit!(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "s1" } })}\n\n`)
      await draining

      expect(events.map((event) => event.type)).toContain("message.part.updated")

      // The lease is released with the turn, and the reaper is armed again
      // rather than disarmed: an idle server still gets torn down.
      expect(backing.lifecycle.activeLeases()).toBe(0)
      backing.fireIdle()
      await Promise.resolve()
      await Promise.resolve()
      expect(backing.stopped).toEqual([1])
    } finally {
      globalThis.fetch = prev
    }
  })
})

describe("OpenCodeHarnessAdapter external transport", () => {
  test("removes stale compression headers after fetch decompresses a response", async () => {
    const prev = globalThis.fetch
    const body = JSON.stringify({ data: [{ type: "session.next.prompt.admitted", prompt: "x".repeat(2_000) }] })
    globalThis.fetch = fakeGlobalFetch(async () => new Response(body, {
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": "128",
      },
    }))

    try {
      const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096")
      const response = await (await adapter.getRequestFn())(new Request("http://opencode.internal/api/session/s1/history"))

      expect(response.headers.get("content-encoding")).toBeNull()
      expect(response.headers.get("content-length")).toBeNull()
      expect(await response.json()).toEqual(JSON.parse(body))
    } finally {
      globalThis.fetch = prev
    }
  })
})
