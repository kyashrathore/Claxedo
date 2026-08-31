import { describe, expect, test } from "bun:test"
import type { JsonRecord } from "../shared/sdk-runtime-driver"
import { spawnDynamicCodexAgent } from "./dynamic-agent"

class FakeDynamicProcess {
  readonly requests: Array<{ method: string; params: unknown }> = []
  readonly listeners = new Set<(message: JsonRecord) => void>()
  turnStartError?: Error
  completeOnStart = true

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params })
    if (method === "thread/start") return { thread: { id: "child-1" } }
    if (method === "turn/start") {
      if (this.turnStartError) throw this.turnStartError
      if (this.completeOnStart) queueMicrotask(() => this.emit("child-1", "turn/completed"))
      return {}
    }
    throw new Error(`Unexpected request ${method}`)
  }

  onMessage(listener: (message: JsonRecord) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(threadId: string, method: string) {
    for (const listener of this.listeners) listener({ method, params: { threadId } })
  }
}

function input(process: FakeDynamicProcess, observations: JsonRecord[]) {
  return {
    active: {
      sessionId: "session-1",
      agentSessionId: "parent-1",
      directory: "/repo",
      process,
      async observeSubagent(item: { observation: JsonRecord }) {
        observations.push(item.observation)
        return { event: { type: "subagent.updated", properties: item.observation } as never }
      },
    },
    params: { callId: "call-1", arguments: { task_name: "review", message: "Inspect this" } },
    frame: { id: "request-1" },
    permissionModeId: "default",
  }
}

describe("spawnDynamicCodexAgent", () => {
  test("observes a successful child from running through completion", async () => {
    const process = new FakeDynamicProcess()
    const observations: JsonRecord[] = []

    await expect(spawnDynamicCodexAgent(input(process, observations))).resolves.toEqual({
      contentItems: [{ type: "inputText", text: "Subagent child-1 completed successfully." }],
      success: true,
    })
    expect(observations.map((row) => row.status)).toEqual(["running", "completed"])
  })

  test("observes a child turn failure", async () => {
    const process = new FakeDynamicProcess()
    process.turnStartError = new Error("turn rejected")
    const observations: JsonRecord[] = []

    await expect(spawnDynamicCodexAgent(input(process, observations))).resolves.toMatchObject({ success: false })
    expect(observations.map((row) => row.status)).toEqual(["running", "failed"])
    expect(observations.at(-1)?.label).toBe("turn rejected")
  })

  test("ignores completion frames for another child", async () => {
    const process = new FakeDynamicProcess()
    process.completeOnStart = false
    const observations: JsonRecord[] = []
    let settled = false
    const result = spawnDynamicCodexAgent(input(process, observations)).finally(() => { settled = true })

    while (process.listeners.size === 0) await Promise.resolve()
    process.emit("other-child", "turn/completed")
    await Promise.resolve()
    expect(settled).toBe(false)

    process.emit("child-1", "turn/completed")
    await expect(result).resolves.toMatchObject({ success: true })
  })

  test("removes the child listener after turn-start failure", async () => {
    const process = new FakeDynamicProcess()
    process.turnStartError = new Error("turn rejected")

    await spawnDynamicCodexAgent(input(process, []))

    expect(process.listeners.size).toBe(0)
  })
})
