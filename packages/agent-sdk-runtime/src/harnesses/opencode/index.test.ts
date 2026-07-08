import { describe, expect, test } from "bun:test"
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
      OPENCODE_CONFIG_DIR: "/tmp/opencode-config",
    })

    expect(env.CLAXEDO_WR_RELAY_HOST_PUBLIC_KEY_JWK).toBeUndefined()
    expect(env.CLAXEDO_WR_RELAY_JWT_ALG).toBeUndefined()
    expect(env.CLAXEDO_RELAY_JWKS_URL).toBeUndefined()
    expect(env.CLAXEDO_RELAY_HOST_VERIFY_PEM).toBeUndefined()
    expect(env.WORKSPACE_RUNTIME_CONFIG_TOKEN).toBeUndefined()
    expect(env.CLAXEDO_WR_TRUSTED_DIRECT_TOKEN).toBeUndefined()
    expect(env.CLAXEDO_CONTROL_PLANE_URL).toBeUndefined()
    expect(env.CLAXEDO_CONTROL_PLANE_JWKS_URL).toBeUndefined()
    expect(env.OPENCODE_CONFIG_DIR).toBe("/tmp/opencode-config")
  })

  test("emits session.error when the event stream ends before a terminal event", async () => {
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096")
    const prev = globalThis.fetch
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined

    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      if (req.url.endsWith("/global/event")) {
        return new Response(new ReadableStream<Uint8Array>({
          start(next) {
            ctrl = next
          },
        }), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }
      if (req.url.endsWith("/session/s1/prompt_async")) {
        queueMicrotask(() => ctrl?.close())
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected fetch: ${req.url}`)
    }) as typeof fetch

    try {
      const events = []
      for await (const event of adapter.sendMessage("s1", prompt(), "/work")) {
        events.push(event)
      }

      expect(events.some((event) => event.type === "message.completed")).toBe(false)
      expect(events.at(-1)).toMatchObject({
        type: "session.error",
        properties: {
          sessionID: "s1",
          error: {
            data: {
              message: "OpenCode event stream ended before the session completed",
            },
          },
        },
      })
    } finally {
      globalThis.fetch = prev
    }
  })

  test("closes the global event stream when the consumer breaks early", async () => {
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096")
    const prev = globalThis.fetch
    const enc = new TextEncoder()
    let aborted = false
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined

    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      if (req.url.endsWith("/global/event")) {
        req.signal.addEventListener("abort", () => {
          aborted = true
        })
        return new Response(new ReadableStream<Uint8Array>({
          start(next) {
            ctrl = next
          },
        }), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }
      if (req.url.endsWith("/session/s1/prompt_async")) {
        queueMicrotask(() => {
          ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({
            type: "session.status",
            properties: { sessionID: "s1", status: { type: "busy" } },
          })}\n\n`))
        })
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected fetch: ${req.url}`)
    }) as typeof fetch

    try {
      let count = 0
      for await (const _event of adapter.sendMessage("s1", prompt(), "/work")) {
        count++
        if (count === 4) break
      }

      expect(aborted).toBe(true)
    } finally {
      globalThis.fetch = prev
    }
  })
})

describe("OpenCodeHarnessAdapter injected-request transport", () => {
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
    globalThis.fetch = (async () => {
      throw new Error("network must not be used in injected mode")
    }) as typeof fetch
    try {
      const adapter = new OpenCodeHarnessAdapter(undefined, { request: handler })

      expect(await adapter.listSessions("/work")).toEqual([{ id: "ses_a" } as never])
      expect(await adapter.createSession("/work", "Title")).toEqual({ id: "ses_new" })
      const status = await adapter.getStatusSnapshot("/work")
      expect(await status.json()).toEqual({ active: { type: "idle" } })

      expect(seen).toEqual([
        { method: "GET", path: "/session", directory: "/work", body: "" },
        { method: "POST", path: "/session", directory: "/work", body: JSON.stringify({ title: "Title" }) },
        { method: "GET", path: "/session/status", directory: "/work", body: "" },
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
    await adapter.createSession("/work", "Body Session")
    expect(received).toBe(JSON.stringify({ title: "Body Session" }))
  })

  test("bridges a streaming text/event-stream Response from the injected handler", async () => {
    const enc = new TextEncoder()
    let promptSeen = false
    const handler: OpenCodeRequestFn = async (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/global/event") {
        return new Response(new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({
              type: "session.status",
              properties: { sessionID: "s1", status: { type: "busy" } },
            })}\n\n`))
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({
              type: "session.idle",
              properties: { sessionID: "s1" },
            })}\n\n`))
          },
        }), { status: 200, headers: { "Content-Type": "text/event-stream" } })
      }
      if (url.pathname === "/session/s1/prompt_async") {
        promptSeen = true
        return new Response(null, { status: 204 })
      }
      return new Response("unexpected", { status: 500 })
    }

    const adapter = new OpenCodeHarnessAdapter(undefined, { request: handler })
    const events = []
    for await (const event of adapter.sendMessage("s1", prompt(), "/work")) {
      events.push(event)
    }

    expect(promptSeen).toBe(true)
    expect(events.some((event) => event.type === "session.status")).toBe(true)
    expect(events.some((event) => event.type === "session.idle")).toBe(true)
  })
})
