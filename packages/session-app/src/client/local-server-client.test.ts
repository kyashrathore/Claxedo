import { describe, expect, test } from "bun:test"
import { createLocalServerClient, readSseStream } from "./local-server-client"

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("local server client", () => {
  test("lists sessions and tolerates junk entries", async () => {
    const client = createLocalServerClient({
      baseUrl: "http://127.0.0.1:1707",
      fetcher: async (url) => {
        expect(url).toBe("http://127.0.0.1:1707/session?directory=%2Ftmp%2Fp")
        return response([{ id: "ses_1", title: "First" }, { nope: true }, "junk"])
      },
    })
    expect(await client.listSessions("/tmp/p")).toEqual([{ id: "ses_1", title: "First" }])
  })

  test("sends prompts as text parts to the session message route", async () => {
    let sent: { url: string; body: unknown } | undefined
    const client = createLocalServerClient({
      baseUrl: "http://127.0.0.1:1707",
      fetcher: async (url, init) => {
        sent = { url, body: JSON.parse(String(init?.body)) }
        return response({ ok: true })
      },
    })
    await client.sendPrompt({ sessionId: "ses 1", directory: "/tmp/p", text: "hello" })
    expect(sent?.url).toBe("http://127.0.0.1:1707/session/ses%201/message?directory=%2Ftmp%2Fp")
    expect(sent?.body).toEqual({ parts: [{ type: "text", text: "hello" }] })
  })

  test("surfaces non-2xx as errors with the body excerpt", async () => {
    const client = createLocalServerClient({
      baseUrl: "http://127.0.0.1:1707",
      fetcher: async () => new Response("boom", { status: 500 }),
    })
    await expect(client.loadTranscript("s", "/d")).rejects.toThrow(/500: boom/)
  })
})

describe("sse reader", () => {
  test("parses multi-line data frames separated by blank lines", async () => {
    const frames: string[] = []
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode('data: {"a":\n'))
        controller.enqueue(encoder.encode('data: 1}\n\n'))
        controller.enqueue(encoder.encode("id: 7\ndata: second\n\ndata: tail-without-blank"))
        controller.close()
      },
    })
    await readSseStream(stream, (data) => frames.push(data))
    // The unterminated tail is NOT dispatched — SSE frames end at a blank line.
    expect(frames).toEqual(['{"a":\n1}', "second"])
  })
})
