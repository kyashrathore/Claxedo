import path from "path"
import os from "os"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { OpenCodeHarnessAdapter, opencodeAuthContent, prepareSpawnEnv, spawnEnv } from "./index"
import { dataDir } from "../../paths"
import { createRuntimeEventHub, type RuntimeEventEnvelope } from "../../runtime-event-hub"
import type { AgentProcessDescriptor, AgentProcessObserver } from "../../process-observer"
import { observeOpenCodeServerProcess } from "./process"

describe("opencode adapter", () => {
  test("injects the claxedo opencode config dir into spawned env", () => {
    // spawnEnv keeps explicitly-set values on purpose, and CI runners export
    // XDG_* (e.g. XDG_CONFIG_HOME=/home/runner/.config) — clear all four vars
    // the defaulting covers, not just OPENCODE_CONFIG_DIR.
    const keys = ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const
    const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]

    try {
      const env = spawnEnv()
      expect(env.OPENCODE_CONFIG_DIR).toBe(path.join(dataDir(), "opencode-config"))
      expect(env.XDG_CONFIG_HOME).toBe(path.join(dataDir(), "opencode-xdg-config"))
      expect(env.XDG_DATA_HOME).toBe(path.join(dataDir(), "opencode-xdg-data"))
      expect(env.XDG_CACHE_HOME).toBe(path.join(dataDir(), "opencode-xdg-cache"))
    } finally {
      for (const key of keys) {
        if (prev[key] !== undefined) process.env[key] = prev[key]
        else delete process.env[key]
      }
    }
  })

  test("keeps explicitly provided opencode environment paths", () => {
    expect(spawnEnv({
      OPENCODE_CONFIG_DIR: path.resolve("/tmp/opencode-config"),
      XDG_CONFIG_HOME: path.resolve("/tmp/xdg-config"),
      XDG_DATA_HOME: path.resolve("/tmp/xdg-data"),
      XDG_CACHE_HOME: path.resolve("/tmp/xdg-cache"),
    })).toMatchObject({
      OPENCODE_CONFIG_DIR: path.resolve("/tmp/opencode-config"),
      XDG_CONFIG_HOME: path.resolve("/tmp/xdg-config"),
      XDG_DATA_HOME: path.resolve("/tmp/xdg-data"),
      XDG_CACHE_HOME: path.resolve("/tmp/xdg-cache"),
    })
  })

  test("creates opencode-owned config and xdg directories before spawn", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-opencode-env-"))
    await prepareSpawnEnv({
      OPENCODE_CONFIG_DIR: path.join(dir, "config"),
      XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
      XDG_DATA_HOME: path.join(dir, "xdg-data"),
      XDG_CACHE_HOME: path.join(dir, "xdg-cache"),
    })

    await expect(fs.stat(path.join(dir, "config")).then((item) => item.isDirectory())).resolves.toBe(true)
    await expect(fs.stat(path.join(dir, "xdg-config")).then((item) => item.isDirectory())).resolves.toBe(true)
    await expect(fs.stat(path.join(dir, "xdg-data")).then((item) => item.isDirectory())).resolves.toBe(true)
    await expect(fs.stat(path.join(dir, "xdg-cache")).then((item) => item.isDirectory())).resolves.toBe(true)
  })

  test("retains a fixed upstream url after dispose", async () => {
    const eventHub = createRuntimeEventHub()
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096", { eventHub })

    adapter.dispose()

    await expect(adapter.getServerUrl()).resolves.toBe("http://127.0.0.1:4096")
  })

  test("distinguishes injected and external OpenCode ownership without config secrets", async () => {
    const sentinel = "opencode-observer-sentinel"
    const descriptors: AgentProcessDescriptor[] = []
    const processObserver: AgentProcessObserver = {
      register(descriptor) {
        descriptors.push(descriptor)
        return { update: () => undefined, exit: () => undefined }
      },
    }
    const config = {
      mcp: {
        local: {
          name: "local",
          source: "user",
          transport: "stdio",
          command: "node",
          args: [sentinel],
          env: { TOKEN: sentinel },
        },
        remote: {
          name: "remote",
          source: "user",
          transport: "remote",
          url: "https://mcp.example",
          headers: { Authorization: sentinel },
        },
      },
      auth: { TOKEN: sentinel },
    }
    const external = new OpenCodeHarnessAdapter("https://external.example", { processObserver })
    const injected = new OpenCodeHarnessAdapter(undefined, {
      processObserver,
      request: async () => new Response("{}"),
    })

    await external.applyConfig(config)
    await injected.applyConfig(config)

    expect(descriptors.map((descriptor) => [descriptor.role, descriptor.locality, descriptor.confidence])).toEqual([
      ["harness", "remote", "not-process-backed"],
      ["harness", "in-process", "direct"],
      ["mcp", "remote", "not-process-backed"],
      ["mcp", "remote", "not-process-backed"],
      ["mcp", "in-process", "inferred"],
      ["mcp", "remote", "not-process-backed"],
    ])
    expect(JSON.stringify(descriptors)).not.toContain(sentinel)
    external.dispose()
    injected.dispose()
  })

  test("registers a spawned OpenCode PID and inferred stdio MCP child", () => {
    const descriptors: AgentProcessDescriptor[] = []
    const observer: AgentProcessObserver = {
      register(descriptor) {
        descriptors.push(descriptor)
        return { update: () => undefined, exit: () => undefined }
      },
    }
    const handle = observeOpenCodeServerProcess({
      observer,
      pid: 654,
      directory: path.resolve("/safe/workspace"),
      config: {
        local: {
          name: "local",
          source: "user",
          transport: "stdio",
          command: "node",
          args: [],
          env: {},
        },
      },
    })

    expect(descriptors).toMatchObject([
      {
        harnessId: "opencode",
        role: "harness",
        pid: 654,
        confidence: "direct",
      },
      {
        harnessId: "opencode",
        role: "mcp",
        confidence: "inferred",
        parentOwnerId: descriptors[0]?.ownerId,
      },
    ])
    handle.exit({ reason: "disposed" })
  })

  test("reports OpenCode harness capabilities", () => {
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096")

    expect(adapter.readHarnessCapabilities()).toEqual({
      harness: "opencode",
      abort: true,
      reconnect: false,
      replay: true,
      permissions: true,
      questions: true,
      todos: true,
      commands: true,
      fork: true,
      revert: true,
      unrevert: true,
      configOptions: false,
      subagents: true,
    })
  })

  test("builds OpenCode auth content from raw api keys", () => {
    expect(opencodeAuthContent({ openai: "sk-openai-managed" })).toBe(JSON.stringify({
      openai: {
        type: "api",
        key: "sk-openai-managed",
      },
    }))
  })

  test("builds OpenCode auth content from oauth auth", () => {
    expect(opencodeAuthContent({
      openai: JSON.stringify({
        type: "oauth",
        refresh: "refresh-openai",
        access: "access-openai",
        expires: 1_790_000_000_000,
        accountId: "acct-openai",
      }),
    })).toBe(JSON.stringify({
      openai: {
        type: "oauth",
        refresh: "refresh-openai",
        access: "access-openai",
        expires: 1_790_000_000_000,
        accountId: "acct-openai",
      },
    }))
  })

  test("builds OpenCode auth content from Codex bundles in the canonical OpenAI slot", () => {
    expect(opencodeAuthContent({
      openai: JSON.stringify({
        type: "codex_auth",
        oauth: {
          refresh: "refresh-openai",
          access: "access-openai",
          expires: 1_790_000_000_000,
          account_id: "acct-openai",
        },
      }),
    })).toBe(JSON.stringify({
      openai: {
        type: "oauth",
        refresh: "refresh-openai",
        access: "access-openai",
        expires: 1_790_000_000_000,
        accountId: "acct-openai",
      },
    }))
  })

  test("rejects because opencode does not expose live agent options", async () => {
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096")
    const calls: string[] = []
    const prev = globalThis.fetch

    globalThis.fetch = (async (input) => {
      calls.push(String(input))
      return new Response(JSON.stringify([{ name: "build", mode: "primary" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      await expect(adapter.listAgents(path.resolve("/tmp/ws"))).rejects.toThrow("opencode does not expose live agent options")
      expect(calls).toEqual([])
    } finally {
      globalThis.fetch = prev
    }
  })

  test("forwards configured upstream auth headers", async () => {
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096", {
      headers: { authorization: "Basic test-token" },
    })
    let auth = ""
    const prev = globalThis.fetch

    globalThis.fetch = (async (input, init) => {
      // URL-mode transport now dispatches a single `Request` object (the adapter
      // builds against a synthetic base and the RequestFn rewrites the origin),
      // so read the forwarded auth from the Request rather than the init arg.
      const req = input instanceof Request ? input : new Request(String(input), init)
      auth = req.headers.get("authorization") ?? ""
      return new Response(JSON.stringify({ id: "session-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      await expect(adapter.createSession(path.resolve("/tmp/ws"))).resolves.toEqual({ id: "session-1" })
      expect(auth).toBe("Basic test-token")
    } finally {
      globalThis.fetch = prev
    }
  })

  test("proxies status snapshots through the adapter with workspace context", async () => {
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096")
    const calls: Array<{ url: string; directory: string; workspace: string }> = []
    const prev = globalThis.fetch

    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push({
        url: req.url,
        directory: req.headers.get("x-opencode-directory") ?? "",
        workspace: req.headers.get("x-workspace-id") ?? "",
      })
      return new Response(JSON.stringify({ idle: true, sessions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      const res = await adapter.getStatusSnapshot(path.resolve("/tmp/ws"), {
        headers: { "x-workspace-id": "workspace-1" },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ idle: true, sessions: [] })
      expect(calls).toEqual([{
        url: "http://127.0.0.1:4096/session/status",
        directory: path.resolve("/tmp/ws"),
        workspace: "workspace-1",
      }])
    } finally {
      globalThis.fetch = prev
    }
  })

  test("syncs configured MCP through the opencode adapter before creating a session", async () => {
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096")
    const calls: Array<{ url: string; method?: string; directory: string; body: unknown }> = []
    const prev = globalThis.fetch

    await adapter.applyConfig({
      mcp: {
        docs: {
          name: "docs",
          source: "user",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          env: { OPENCODE_API_URL: "http://localhost:3001" },
        },
      },
    })

    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push({
        url: req.url,
        method: req.method,
        directory: req.headers.get("x-opencode-directory") ?? "",
        body: req.method === "POST" ? await req.json().catch(() => undefined) : undefined,
      })
      if (req.url.endsWith("/mcp")) return new Response(JSON.stringify({ docs: { status: "connected" } }))
      return new Response(JSON.stringify({ id: "session-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      await expect(adapter.createSession(path.resolve("/tmp/ws"), "Triage")).resolves.toEqual({ id: "session-1" })
      expect(calls).toEqual([
        {
          url: "http://127.0.0.1:4096/mcp",
          method: "POST",
          directory: path.resolve("/tmp/ws"),
          body: {
            name: "docs",
            config: {
              type: "local",
              command: ["node", "server.js"],
              environment: { OPENCODE_API_URL: "http://localhost:3001" },
            },
          },
        },
        {
          url: "http://127.0.0.1:4096/session",
          method: "POST",
          directory: path.resolve("/tmp/ws"),
          body: { title: "Triage" },
        },
      ])
    } finally {
      globalThis.fetch = prev
    }
  })

  test("waits for the event stream before sending prompt_async", async () => {
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096")
    const prev = globalThis.fetch
    const calls: string[] = []
    const enc = new TextEncoder()
    let open = () => {}
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined

    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(req.url)

      if (req.url.endsWith("/global/event")) {
        return new Promise<Response>((resolve) => {
          open = () =>
            resolve(new Response(new ReadableStream<Uint8Array>({
              start(next) {
                ctrl = next
              },
            }), {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            }))
        })
      }

      if (req.url.endsWith("/session/ses_test/prompt_async")) {
        return new Response(null, {
          status: 204,
          headers: { "Content-Type": "application/json" },
        })
      }

      throw new Error(`unexpected fetch: ${req.url}`)
    }) as typeof fetch

    try {
      const iter = adapter.sendMessage("ses_test", {
        parts: [{ type: "text", text: "hello" }],
        userMessageId: "msg_user",
        assistantMessageId: "msg_asst",
        agent: "build",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6",
        },
      }, path.resolve("/tmp/ws"))[Symbol.asyncIterator]()

      expect((await iter.next()).value?.type).toBe("message.updated")
      expect((await iter.next()).value?.type).toBe("message.part.updated")
      expect((await iter.next()).value?.type).toBe("message.updated")

      const busy = iter.next()
      await Promise.resolve()

      expect(calls).toEqual(["http://127.0.0.1:4096/global/event"])

      open()
      for (let i = 0; i < 10 && calls.length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      expect(calls).toEqual([
        "http://127.0.0.1:4096/global/event",
        "http://127.0.0.1:4096/session/ses_test/prompt_async",
      ])

      ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({
        type: "session.status",
        properties: {
          sessionID: "ses_test",
          status: { type: "busy" },
        },
      })}\n\n`))
      ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({
        type: "session.idle",
        properties: { sessionID: "ses_test" },
      })}\n\n`))
      ctrl?.close()

      expect((await busy).value?.type).toBe("session.status")
      expect((await iter.next()).value?.type).toBe("session.idle")
      expect((await iter.next()).value?.type).toBe("session.error")
      expect((await iter.next()).done).toBe(true)
    } finally {
      globalThis.fetch = prev
    }
  })

  test("publishes canonical runtime events while forwarding OpenCode compat events", async () => {
    const eventHub = createRuntimeEventHub()
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096", { eventHub })
    const prev = globalThis.fetch
    const enc = new TextEncoder()
    const runtime: RuntimeEventEnvelope[] = []
    const unsubscribe = eventHub.subscribeRuntime((event) => runtime.push(event))
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

      if (req.url.endsWith("/session/ses_test/prompt_async")) {
        queueMicrotask(() => {
          ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({
            type: "message.part.delta",
            properties: {
              sessionID: "ses_test",
              messageID: "msg_asst",
              partID: "part_text",
              field: "text",
              delta: "hello",
            },
          })}\n\n`))
          ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({
            type: "session.idle",
            properties: { sessionID: "ses_test" },
          })}\n\n`))
        })
        return new Response(null, { status: 204 })
      }

      throw new Error(`unexpected fetch: ${req.url}`)
    }) as typeof fetch

    try {
      const compat = []
      for await (const event of adapter.sendMessage("ses_test", {
        parts: [{ type: "text", text: "hello" }],
        userMessageId: "msg_user",
        assistantMessageId: "msg_asst",
        agent: "build",
        model: {
          providerID: "opencode",
          modelID: "big-pickle",
        },
      }, path.resolve("/tmp/ws"))) {
        compat.push(event.type)
      }

      expect(compat).toEqual([
        "message.updated",
        "message.part.updated",
        "message.updated",
        "message.part.delta",
        "session.idle",
        "message.completed",
      ])
      expect(runtime.map((event) => event.payload)).toEqual([
        { type: "session-status", status: "busy" },
        { type: "text-delta", delta: "hello" },
        { type: "finish", sessionId: "ses_test" },
      ])
      expect(runtime.every((event) => event.directory === path.resolve("/tmp/ws") && event.sessionId === "ses_test")).toBe(true)
    } finally {
      unsubscribe()
      globalThis.fetch = prev
    }
  })

  test("finishes the prompt stream when OpenCode emits a completed assistant message without idle", async () => {
    const adapter = new OpenCodeHarnessAdapter("http://127.0.0.1:4096")
    const prev = globalThis.fetch
    const enc = new TextEncoder()
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

      if (req.url.endsWith("/session/ses_test/prompt_async")) {
        queueMicrotask(() => {
          ctrl?.enqueue(enc.encode(`data: ${JSON.stringify({
            type: "message.updated",
            properties: {
              sessionID: "ses_test",
              info: {
                id: "msg_done",
                sessionID: "ses_test",
                role: "assistant",
                time: { created: Date.now(), completed: Date.now() },
                parentID: "msg_user",
                modelID: "big-pickle",
                providerID: "opencode",
                mode: "build",
                agent: "build",
                path: { cwd: path.resolve("/tmp/ws"), root: path.resolve("/tmp/ws") },
                cost: 0,
                tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                finish: "stop",
              },
            },
          })}\n\n`))
        })
        return new Response(null, { status: 204 })
      }

      throw new Error(`unexpected fetch: ${req.url}`)
    }) as typeof fetch

    try {
      const events = []
      for await (const event of adapter.sendMessage("ses_test", {
        parts: [{ type: "text", text: "hello" }],
        userMessageId: "msg_user",
        assistantMessageId: "msg_asst",
        agent: "build",
        model: {
          providerID: "opencode",
          modelID: "big-pickle",
        },
      }, path.resolve("/tmp/ws"))) {
        events.push(event.type)
      }

      expect(events).toEqual([
        "message.updated",
        "message.part.updated",
        "message.updated",
        "message.updated",
        "session.error",
      ])
    } finally {
      globalThis.fetch = prev
    }
  })
})
