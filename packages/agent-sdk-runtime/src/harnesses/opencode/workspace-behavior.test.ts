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
      goals: true,
    })
  })

  test("maps the first-party OpenCode Goal resource without prompt fallback", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const statuses: Array<string | null> = []
    const eventHub = createRuntimeEventHub()
    eventHub.subscribeRuntime((event) => {
      if (event.payload.type === "goal-updated") statuses.push(event.payload.goal.status)
      if (event.payload.type === "goal-cleared") statuses.push(null)
    })
    let goal: null | {
      sessionId: string
      objective: string
      status: "active" | "complete"
      createdAt: number
      updatedAt: number
      iteration: number
      lastReason?: string
    } = null
    let reconcile = false
    const adapter = new OpenCodeHarnessAdapter(undefined, {
      eventHub,
      request: async (request) => {
        const url = new URL(request.url)
        const body = request.body ? await request.clone().json() : undefined
        calls.push({ method: request.method, path: url.pathname, ...(body ? { body } : {}) })
        if (url.pathname.endsWith("/goal/capabilities")) {
          return Response.json({
            implemented: true,
            available: true,
            actions: ["pause", "resume", "delete"],
            recovery: "reconcile",
            optionalFields: ["iteration", "lastReason"],
          })
        }
        if (url.pathname.endsWith("/goal") && request.method === "POST") {
          const now = Date.now()
          goal = {
            sessionId: "session-1",
            objective: (body as { objective: string }).objective,
            status: "active",
            createdAt: now,
            updatedAt: now,
            iteration: 0,
          }
          reconcile = true
          return Response.json(goal)
        }
        if (url.pathname.endsWith("/goal") && request.method === "GET") {
          if (goal && reconcile) {
            reconcile = false
            goal = { ...goal, status: "complete", updatedAt: Date.now(), iteration: 1, lastReason: "Verified" }
          }
          return Response.json(goal)
        }
        if (url.pathname.endsWith("/goal") && request.method === "DELETE") {
          goal = null
          return Response.json(null)
        }
        throw new Error(`unexpected request: ${request.method} ${url.pathname}`)
      },
    })

    expect(await adapter.goals.readCapabilities("session-1", "/repo")).toMatchObject({
      available: true,
      actions: ["pause", "resume", "delete"],
    })
    expect(await adapter.goals.start("session-1", { objective: "Ship verified work" }, "/repo"))
      .toMatchObject({ ok: true, goal: { status: "active" } })
    const deadline = Date.now() + 1_000
    while (!statuses.includes("complete") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(statuses).toEqual(["active", "complete"])
    expect(calls.some((call) => call.path.endsWith("/prompt_async"))).toBe(false)
    expect(await adapter.goals.delete("session-1", "/repo")).toEqual({ ok: true, goal: null })
    expect(statuses.at(-1)).toBeNull()
    adapter.dispose()
  })

  test("reconciles an active Goal after transient Goal-read failures", async () => {
    const statuses: string[] = []
    const eventHub = createRuntimeEventHub()
    eventHub.subscribeRuntime((event) => {
      if (event.payload.type === "goal-updated") statuses.push(event.payload.goal.status)
    })
    let goalReads = 0
    const active = {
      sessionId: "session-retry",
      objective: "Recover monitoring",
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
      iteration: 0,
    }
    const adapter = new OpenCodeHarnessAdapter(undefined, {
      eventHub,
      request: async (request) => {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/goal") && request.method === "POST") return Response.json(active)
        if (url.pathname.endsWith("/goal") && request.method === "GET") {
          goalReads += 1
          if (goalReads < 3) throw new Error("temporary Goal read failure")
          return Response.json({ ...active, status: "complete", updatedAt: 2, iteration: 1 })
        }
        throw new Error(`unexpected request: ${request.method} ${url.pathname}`)
      },
    })

    expect(await adapter.goals.start("session-retry", { objective: active.objective }, "/repo"))
      .toMatchObject({ ok: true, goal: { status: "active" } })
    const deadline = Date.now() + 2_000
    while (!statuses.includes("complete") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(goalReads).toBe(3)
    expect(statuses).toEqual(["active", "complete"])
    adapter.dispose()
  })

  test("shares one server event stream across Goals and follows each Goal the engine announces", async () => {
    type Snapshot = {
      sessionId: string
      objective: string
      status: "active" | "complete"
      createdAt: number
      updatedAt: number
      iteration: number
    }
    const encoder = new TextEncoder()
    const stored = new Map<string, Snapshot>()
    const goalReads: string[] = []
    const completed: string[] = []
    let streamOpens = 0
    let feed: ReadableStreamDefaultController<Uint8Array> | undefined

    const eventHub = createRuntimeEventHub()
    eventHub.subscribeRuntime((event) => {
      if (event.payload.type === "goal-updated" && event.payload.goal.status === "complete") {
        completed.push(event.payload.goal.sessionId)
      }
    })

    const adapter = new OpenCodeHarnessAdapter(undefined, {
      eventHub,
      request: async (request) => {
        const url = new URL(request.url)
        if (url.pathname === "/global/event") {
          streamOpens += 1
          return new Response(
            new ReadableStream<Uint8Array>({
              start(next) {
                feed = next
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          )
        }
        const sessionId = url.pathname.match(/^\/session\/([^/]+)\/goal$/)?.[1]
        if (sessionId && request.method === "POST") {
          const { objective } = (await request.json()) as { objective: string }
          const goal: Snapshot = {
            sessionId,
            objective,
            status: "active",
            createdAt: 1,
            updatedAt: 1,
            iteration: 0,
          }
          stored.set(sessionId, goal)
          return Response.json(goal)
        }
        if (sessionId && request.method === "GET") {
          goalReads.push(sessionId)
          return Response.json(stored.get(sessionId) ?? null)
        }
        throw new Error(`unexpected request: ${request.method} ${url.pathname}`)
      },
    })

    const until = async (predicate: () => boolean, what: string) => {
      const deadline = Date.now() + 2_000
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
      if (!predicate()) throw new Error(`timed out waiting for ${what}`)
    }
    const push = (payload: unknown) => feed!.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
    const sessionUpdated = (id: string, metadata?: Record<string, unknown>) => ({
      type: "session.updated",
      properties: {
        sessionID: id,
        info: { id, title: "t", directory: "/repo", ...(metadata ? { metadata } : {}) },
      },
    })

    try {
      expect(await adapter.goals.start("goal-a", { objective: "A" }, "/repo")).toMatchObject({ ok: true })
      await until(() => streamOpens === 1 && feed !== undefined, "the shared event stream")
      expect(await adapter.goals.start("goal-b", { objective: "B" }, "/repo")).toMatchObject({ ok: true })
      await until(() => goalReads.includes("goal-b"), "the second Goal's first read")

      // Turn churn touches no metadata, so it says nothing about either Goal
      // and costs no read: the engine's own announcement is the live channel.
      const readsBefore = goalReads.length
      for (let i = 0; i < 3; i += 1) push(sessionUpdated("goal-a"))
      for (let i = 0; i < 3; i += 1) push(sessionUpdated("goal-b"))
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(goalReads.length).toBe(readsBefore)

      // One Goal finishing leaves the other one's stream untouched.
      const done = { ...stored.get("goal-a")!, status: "complete" as const, iteration: 2 }
      stored.set("goal-a", done)
      push(sessionUpdated("goal-a", { "claxedo.goal": done }))
      await until(() => completed.includes("goal-a"), "the completed Goal")
      expect(streamOpens).toBe(1)
      expect(goalReads.length).toBe(readsBefore)
    } finally {
      adapter.dispose()
    }
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
