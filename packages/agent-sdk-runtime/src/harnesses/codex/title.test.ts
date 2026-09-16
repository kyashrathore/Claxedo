import { describe, expect, test } from "bun:test"
import type { JsonRecord } from "../shared/sdk-runtime-adapter"
import type { SessionTitleRequest } from "../../title-generation"
import { generateCodexTitle, setCodexThreadName, type CodexTitleProcess } from "./title"

function fakeProcess(options: { reply?: string; failTurn?: boolean; startTurn?: () => Promise<unknown> } = {}) {
  const calls: Array<{ method: string; params: JsonRecord }> = []
  const listeners = new Set<(message: JsonRecord) => void>()
  const emit = (message: JsonRecord) => { for (const listener of listeners) listener(message) }
  const proc: CodexTitleProcess = {
    async request(method, params) {
      calls.push({ method, params: params as JsonRecord })
      if (method === "thread/start") return { thread: { id: "title-thread" } }
      if (method === "turn/start") {
        if (options.startTurn) return await options.startTurn()
        queueMicrotask(() => {
          emit({ method: "item/completed", params: { threadId: "other-thread", item: { type: "agentMessage", text: "not ours" } } })
          if (options.reply !== undefined) {
            emit({ method: "item/completed", params: { threadId: "title-thread", item: { type: "agentMessage", text: options.reply } } })
          }
          emit({ method: "turn/completed", params: { threadId: "title-thread", turn: options.failTurn ? { status: "failed", error: { message: "quota" } } : { status: "completed" } } })
        })
        return { turn: { id: "turn-1" } }
      }
      return {}
    },
    onMessage(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return { proc, calls, listeners }
}

function request(signal = new AbortController().signal): SessionTitleRequest {
  return { directory: "/work", system: "Name it", user: "User: add leap-year tests", model: { providerID: "codex", modelID: "gpt-5.5" }, signal }
}

function input(proc: CodexTitleProcess, released: string[], req = request()) {
  return {
    request: req,
    process: async () => proc,
    lease: () => ({ release: () => { released.push("released") } }),
    model: "gpt-5.5",
    config: { features: { default_mode_request_user_input: true } },
  }
}

describe("generateCodexTitle", () => {
  test("runs one structured turn on an ephemeral read-only thread and archives it", async () => {
    const { proc, calls, listeners } = fakeProcess({ reply: JSON.stringify({ title: "Add leap-year tests" }) })
    const released: string[] = []

    await expect(generateCodexTitle(input(proc, released))).resolves.toBe("Add leap-year tests")

    expect(calls.map((call) => call.method)).toEqual(["thread/start", "turn/start", "thread/archive"])
    expect(calls[0]?.params).toMatchObject({ cwd: "/work", ephemeral: true, sandbox: "read-only", approvalPolicy: "never", developerInstructions: "Name it", model: "gpt-5.5", config: { features: { default_mode_request_user_input: true } } })
    expect(calls[1]?.params).toMatchObject({
      threadId: "title-thread",
      input: [{ type: "text", text: "User: add leap-year tests" }],
      sandboxPolicy: { type: "readOnly" },
      outputSchema: { type: "object", required: ["title"] },
    })
    expect(calls[2]?.params).toEqual({ threadId: "title-thread" })
    expect(listeners.size).toBe(0)
    expect(released).toEqual(["released"])
  })

  test("returns the raw reply when the model ignored the schema", async () => {
    const { proc } = fakeProcess({ reply: "Add leap-year tests" })
    await expect(generateCodexTitle(input(proc, []))).resolves.toBe("Add leap-year tests")
  })

  test("a failed turn yields null, still archives, and releases the lease", async () => {
    const { proc, calls } = fakeProcess({ failTurn: true })
    const released: string[] = []
    await expect(generateCodexTitle(input(proc, released))).resolves.toBeNull()
    expect(calls.map((call) => call.method)).toEqual(["thread/start", "turn/start", "thread/archive"])
    expect(released).toEqual(["released"])
  })

  test("abort interrupts the turn and yields null", async () => {
    const controller = new AbortController()
    const { proc, calls } = fakeProcess({ startTurn: async () => ({ turn: { id: "turn-1" } }) })
    const pending = generateCodexTitle(input(proc, [], request(controller.signal)))
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).resolves.toBeNull()
    expect(calls.map((call) => call.method)).toEqual(["thread/start", "turn/start", "turn/interrupt", "thread/archive"])
    expect(calls[2]?.params).toEqual({ threadId: "title-thread", turnId: "turn-1" })
  })
})

describe("setCodexThreadName", () => {
  test("names the thread and skips empty titles or a dead process", async () => {
    const { proc, calls } = fakeProcess()
    await setCodexThreadName(proc, "thread-9", "Add leap-year tests")
    await setCodexThreadName(proc, "thread-9", "   ")
    await setCodexThreadName(null, "thread-9", "Ignored")
    expect(calls).toEqual([{ method: "thread/name/set", params: { threadId: "thread-9", name: "Add leap-year tests" } }])
  })
})
