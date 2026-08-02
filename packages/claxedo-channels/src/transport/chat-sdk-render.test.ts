import { afterEach, describe, expect, test, vi } from "vitest"
import { createChatSdkRenderer, type ChatSdkApprovalCard, type ChatSdkThread } from "./chat-sdk-render"

/**
 * `thread.post` takes `string | AsyncIterable<string>`. These tests assert on
 * plain-text posts, so a stream reaching one of them means the renderer took
 * the native-streaming path where the test expected a discrete message — that
 * is a real behavior change and should fail here rather than be coerced into a
 * useless "[object Object]" comparison. The streaming tests below consume the
 * iterable directly instead of using this.
 */
function postedText(input: string | AsyncIterable<string>): string {
  if (typeof input !== "string") throw new Error("expected a plain text post, got a stream")
  return input
}

afterEach(() => {
  vi.useRealTimers()
})

describe("createChatSdkRenderer", () => {
  test("retries status posts before falling back", async () => {
    const posts: string[] = []
    const thread: ChatSdkThread = {
      async post(text) {
        posts.push(postedText(text))
        if (posts.length < 3) throw new Error("post failed")
        return {}
      },
    }
    const render = createChatSdkRenderer(thread, { retryDelayMs: 0 })

    await render({ kind: "status", phase: "done", sessionId: "ses_1", appUrl: "/s/ses_1" })

    expect(posts).toEqual([
      "Session ses_1 finished.\nOpen: /s/ses_1",
      "Session ses_1 finished.\nOpen: /s/ses_1",
      "Session ses_1 finished.\nOpen: /s/ses_1",
    ])
  })

  test("falls back to an appUrl terminal post when status retries are exhausted", async () => {
    const posts: string[] = []
    const thread: ChatSdkThread = {
      async post(text) {
        posts.push(postedText(text))
        if (posts.length <= 3) throw new Error("post failed")
        return {}
      },
    }
    const render = createChatSdkRenderer(thread, { retryDelayMs: 0 })

    await render({ kind: "status", phase: "done", sessionId: "ses_1", appUrl: "/s/ses_1" })

    expect(posts).toEqual([
      "Session ses_1 finished.\nOpen: /s/ses_1",
      "Session ses_1 finished.\nOpen: /s/ses_1",
      "Session ses_1 finished.\nOpen: /s/ses_1",
      "Run status changed. Open: /s/ses_1",
    ])
  })

  test("honors retry-after backpressure before retrying reliable posts", async () => {
    vi.useFakeTimers()
    const posts: string[] = []
    const render = createChatSdkRenderer({
      post(text) {
        posts.push(postedText(text))
        if (posts.length === 1) {
          throw {
            response: {
              headers: {
                get(name: string) {
                  return name === "retry-after" ? "2" : undefined
                },
              },
            },
          }
        }
        return {}
      },
    })

    const rendered = render({ kind: "status", phase: "done", sessionId: "ses_1" })
    await Promise.resolve()

    expect(posts).toEqual(["Session ses_1 finished."])

    vi.advanceTimersByTime(1999)
    await Promise.resolve()
    expect(posts).toEqual(["Session ses_1 finished."])

    vi.advanceTimersByTime(1)
    await Promise.resolve()
    await rendered

    expect(posts).toEqual([
      "Session ses_1 finished.",
      "Session ses_1 finished.",
    ])
  })

  test("edits in place for non-approval chunks when possible", async () => {
    const posts: string[] = []
    const edits: string[] = []
    const render = createChatSdkRenderer({
      async post(text) {
        posts.push(postedText(text))
        return {
          edit(next: string) {
            edits.push(next)
          },
        }
      },
    }, { editInPlace: true, nativeStreaming: false })

    await render({ kind: "status", phase: "running", sessionId: "ses_1" })
    await render({ kind: "text", text: "hello", final: false })

    expect(posts).toEqual(["Session ses_1 is running."])
    expect(edits).toEqual(["hello"])
  })

  test("refuses to render an approval on a channel without card support", async () => {
    const posts: string[] = []
    const render = createChatSdkRenderer({
      async post(text) {
        posts.push(postedText(text))
        return {}
      },
    })

    // No silent downgrade to a text prompt: a channel with no button surface
    // has no human approval path, and approvals there go to the judge instead.
    await expect(render({
      kind: "approval",
      request: {
        callId: "ses_1:perm_1",
        token: "a7f3",
        sessionId: "ses_1",
        tool: "bash",
        summary: "Run command",
      },
    })).rejects.toThrow(/interactive card support/)
    expect(posts).toEqual([])
  })

  test("renders approval chunks as native cards when supported", async () => {
    const posts: string[] = []
    const cards: ChatSdkApprovalCard[] = []
    const render = createChatSdkRenderer({
      async post(text) {
        posts.push(postedText(text))
        return {}
      },
      async postCard(card) {
        cards.push(card)
        return {}
      },
    })

    await render({
      kind: "approval",
      request: {
        callId: "ses_1:perm_1",
        token: "a7f3",
        sessionId: "ses_1",
        tool: "bash",
        summary: "Run command",
      },
    })

    expect(posts).toEqual([])
    expect(cards).toEqual([{
      title: "Approval required: bash",
      body: "Approval required for bash: Run command",
      actions: [{
        label: "Approve",
        value: "approve",
        data: { token: "a7f3", approved: true },
      }, {
        label: "Deny",
        value: "deny",
        data: { token: "a7f3", approved: false },
      }],
    }])
  })

  test("names the requestee in the approval card so bystanders know not to press", async () => {
    // Everyone in a group sees the card and can press its buttons, but only the
    // requestee's answer is accepted. Saying so up front beats letting someone
    // find out by being rejected.
    const cards: ChatSdkApprovalCard[] = []
    const render = createChatSdkRenderer({
      async post() {
        return {}
      },
      async postCard(card) {
        cards.push(card)
        return {}
      },
    })

    await render({
      kind: "approval",
      request: {
        callId: "ses_1:perm_1",
        token: "a7f3",
        sessionId: "ses_1",
        tool: "bash",
        summary: "Run command",
        requestee: "asker",
      },
    })

    expect(cards[0]?.body).toBe("Approval required for bash: Run command\nWaiting on asker to answer.")
  })

  test("retries a failing approval card and then fails without downgrading to text", async () => {
    const posts: string[] = []
    let attempts = 0
    const render = createChatSdkRenderer({
      async post(text) {
        posts.push(postedText(text))
        return {}
      },
      async postCard() {
        attempts += 1
        throw new Error("cards unsupported")
      },
    }, { retryDelayMs: 0 })

    await expect(render({
      kind: "approval",
      request: {
        callId: "ses_1:perm_1",
        token: "a7f3",
        sessionId: "ses_1",
        tool: "bash",
        summary: "Run command",
      },
    })).rejects.toThrow(/cards unsupported/)

    expect(attempts).toBe(3)
    // The prompt stays undelivered rather than silently changing the rules the
    // human answers under.
    expect(posts).toEqual([])
  })

  test("posts the approval card once it succeeds after a transient failure", async () => {
    const cards: ChatSdkApprovalCard[] = []
    let attempts = 0
    const render = createChatSdkRenderer({
      async post() {
        return {}
      },
      async postCard(card) {
        attempts += 1
        if (attempts === 1) throw new Error("rate limited")
        cards.push(card)
        return {}
      },
    }, { retryDelayMs: 0 })

    await render({
      kind: "approval",
      request: {
        callId: "ses_1:perm_1",
        token: "a7f3",
        sessionId: "ses_1",
        tool: "bash",
        summary: "Run command",
      },
    })

    expect(attempts).toBe(2)
    expect(cards).toHaveLength(1)
  })

  test("redacts tokens and caps channel posts", async () => {
    const posts: string[] = []
    const render = createChatSdkRenderer({
      async post(text) {
        posts.push(postedText(text))
        return {}
      },
    }, { dataMinimization: { maxLength: 80 }, nativeStreaming: false })

    await render({
      kind: "text",
      text: `token sk-abcdefghijklmnopqrstuvwxyz123456 and ${"x".repeat(120)}`,
      final: false,
    })

    expect(posts[0]).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456")
    expect(posts[0]).toContain("[redacted token]")
    expect(posts[0]).toContain("[truncated; open the session link for full output]")
    expect(posts[0].length).toBeLessThanOrEqual(80)
  })

  test("treats non-final text posts as single-attempt best effort", async () => {
    const posts: string[] = []
    const render = createChatSdkRenderer({
      async post(text) {
        posts.push(postedText(text))
        throw new Error("transient post failure")
      },
    }, { nativeStreaming: false })

    await expect(render({ kind: "text", text: "draft", final: false })).resolves.toBeUndefined()

    expect(posts).toEqual(["draft"])
  })

  test("coalesces non-final edits to the latest chunk within the cadence window", async () => {
    vi.useFakeTimers()
    const posts: string[] = []
    const edits: string[] = []
    const render = createChatSdkRenderer({
      async post(text) {
        posts.push(postedText(text))
        return {
          edit(next: string) {
            edits.push(next)
          },
        }
      },
    }, { editInPlace: true, editCadenceMs: 1000, nativeStreaming: false })

    await render({ kind: "status", phase: "running", sessionId: "ses_1" })
    await render({ kind: "text", text: "first", final: false })
    await render({ kind: "text", text: "second", final: false })
    vi.advanceTimersByTime(999)
    await Promise.resolve()

    expect(posts).toEqual(["Session ses_1 is running."])
    expect(edits).toEqual([])

    vi.advanceTimersByTime(1)
    await Promise.resolve()

    expect(edits).toEqual(["second"])
  })

  test("flushes pending edits before a final chunk", async () => {
    vi.useFakeTimers()
    const edits: string[] = []
    const render = createChatSdkRenderer({
      async post() {
        return {
          edit(next: string) {
            edits.push(next)
          },
        }
      },
    }, { editInPlace: true, editCadenceMs: 1000, nativeStreaming: false })

    await render({ kind: "status", phase: "running", sessionId: "ses_1" })
    await render({ kind: "text", text: "pending", final: false })
    await render({ kind: "text", text: "done", final: true })

    expect(edits).toEqual(["pending", "done"])
  })

  test("streams text deltas through thread.post(AsyncIterable) by default", async () => {
    const posts: unknown[] = []
    const streamed: string[][] = []
    const thread: ChatSdkThread = {
      async post(input) {
        if (typeof input === "string") {
          posts.push(input)
          return {}
        }
        const chunks: string[] = []
        streamed.push(chunks)
        for await (const delta of input) chunks.push(delta)
        return {}
      },
    }
    const render = createChatSdkRenderer(thread)

    await render({ kind: "text", text: "hello ", final: false })
    await render({ kind: "text", text: "hello world", final: false })
    await render({ kind: "text", text: "Open: /s/ses_1", final: true })

    // Deltas only — the SDK stream renders the answer natively.
    expect(streamed).toEqual([["hello ", "world"]])
    // The final link is a SEPARATE message; it must not replace the answer.
    expect(posts).toEqual(["Open: /s/ses_1"])
  })

  test("restarts the stream when already-streamed text is rewritten", async () => {
    const streamed: string[][] = []
    const thread: ChatSdkThread = {
      async post(input) {
        if (typeof input === "string") return {}
        const chunks: string[] = []
        streamed.push(chunks)
        for await (const delta of input) chunks.push(delta)
        return {}
      },
    }
    const render = createChatSdkRenderer(thread)

    await render({ kind: "text", text: "draft one", final: false })
    await render({ kind: "text", text: "rewritten", final: false })
    await render({ kind: "text", text: "Done.", final: true })

    expect(streamed).toEqual([["draft one"], ["rewritten"]])
  })

  test("salvages streamed text with a plain post when the stream fails", async () => {
    const posts: string[] = []
    const thread: ChatSdkThread = {
      async post(input) {
        if (typeof input === "string") {
          posts.push(input)
          return {}
        }
        throw new Error("no stream support")
      },
    }
    const render = createChatSdkRenderer(thread, { retryDelayMs: 0 })

    await render({ kind: "text", text: "the answer", final: false })
    await render({ kind: "text", text: "Open: /s/ses_1", final: true })

    expect(posts).toEqual(["the answer", "Open: /s/ses_1"])
  })

  test("suppresses transient statuses once text is streaming", async () => {
    const posts: string[] = []
    const thread: ChatSdkThread = {
      async post(input) {
        if (typeof input === "string") {
          posts.push(input)
          return {}
        }
        for await (const _delta of input) { /* consume */ }
        return {}
      },
    }
    const render = createChatSdkRenderer(thread)

    await render({ kind: "status", phase: "creating", sessionId: "ses_1", appUrl: "/s/ses_1" })
    await render({ kind: "text", text: "answer", final: false })
    await render({ kind: "status", phase: "running", sessionId: "ses_1" })
    await render({ kind: "status", phase: "done", sessionId: "ses_1" })
    await render({ kind: "text", text: "Open: /s/ses_1", final: true })

    expect(posts).toEqual(["Creating session ses_1.\nOpen: /s/ses_1", "Open: /s/ses_1"])
  })

  test("sanitizes streamed deltas (redaction spans restart the stream safely)", async () => {
    const streamed: string[][] = []
    const thread: ChatSdkThread = {
      async post(input) {
        if (typeof input === "string") return {}
        const chunks: string[] = []
        streamed.push(chunks)
        for await (const delta of input) chunks.push(delta)
        return {}
      },
    }
    const render = createChatSdkRenderer(thread, { dataMinimization: { maxLength: 200 } })

    await render({ kind: "text", text: "token sk-abcdefghijklmnopqrstuvwxyz123456 end", final: false })
    await render({ kind: "text", text: "Done.", final: true })

    const all = streamed.flat().join("")
    expect(all).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456")
    expect(all).toContain("[redacted token]")
  })
})
