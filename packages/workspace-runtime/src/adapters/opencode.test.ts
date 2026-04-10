import path from "path"
import { describe, expect, test } from "bun:test"
import { OpenCodeAdapter, spawnEnv } from "./opencode"
import { dataDir } from "../paths"

describe("opencode adapter", () => {
  test("injects the claxedo opencode config dir into spawned env", () => {
    const prev = process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG_DIR

    try {
      expect(spawnEnv().OPENCODE_CONFIG_DIR).toBe(path.join(dataDir(), "opencode-config"))
    } finally {
      if (prev) process.env.OPENCODE_CONFIG_DIR = prev
      else delete process.env.OPENCODE_CONFIG_DIR
    }
  })

  test("retains a fixed upstream url after dispose", async () => {
    const adapter = new OpenCodeAdapter("http://127.0.0.1:4096")

    adapter.dispose()

    await expect(adapter.getServerUrl()).resolves.toBe("http://127.0.0.1:4096")
  })

  test("lists agents from the opencode /agent route", async () => {
    const adapter = new OpenCodeAdapter("http://127.0.0.1:4096")
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
      await expect(adapter.listAgents("/tmp/ws")).resolves.toEqual([{ name: "build", mode: "primary" }])
      expect(calls).toEqual(["http://127.0.0.1:4096/agent"])
    } finally {
      globalThis.fetch = prev
    }
  })

  test("forwards configured upstream auth headers", async () => {
    const adapter = new OpenCodeAdapter("http://127.0.0.1:4096", {
      headers: { authorization: "Basic test-token" },
    })
    let auth = ""
    const prev = globalThis.fetch

    globalThis.fetch = (async (_input, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? ""
      return new Response(JSON.stringify({ id: "session-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      await expect(adapter.createSession("/tmp/ws")).resolves.toEqual({ id: "session-1" })
      expect(auth).toBe("Basic test-token")
    } finally {
      globalThis.fetch = prev
    }
  })

  test("waits for the event stream before sending prompt_async", async () => {
    const adapter = new OpenCodeAdapter("http://127.0.0.1:4096")
    const prev = globalThis.fetch
    const calls: string[] = []
    const enc = new TextEncoder()
    let open = () => {}
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined

    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(req.url)

      if (req.url.endsWith("/global/event")) {
        return await new Promise<Response>((resolve) => {
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
      }, "/tmp/ws")[Symbol.asyncIterator]()

      expect((await iter.next()).value?.type).toBe("message.updated")
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
      expect((await iter.next()).value?.type).toBe("message.completed")
      expect((await iter.next()).done).toBe(true)
    } finally {
      globalThis.fetch = prev
    }
  })
})
