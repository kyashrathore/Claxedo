import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { cancelAdapterTurn } from "../../test-utils/cancel-turn"
import { executeTestTurn, executionBinding } from "../../test-utils/execution-binding"
import { installFakeCodexAppServer } from "../../test-utils/fake-codex-app-server"
import { CodexHarnessAdapter } from "./index"

const prompt = (text: string, id: string) => ({
  parts: [{ type: "text" as const, text }],
  userMessageId: `user-${id}`,
  assistantMessageId: `assistant-${id}`,
  agent: "build",
  model: { providerID: "codex", modelID: "default" },
})

test("a prompt sent mid-turn is steered into the running turn by its own id", async () => {
  const fake = await installFakeCodexAppServer()
  const store = createMemoryRuntimeStore()
  const adapter = new CodexHarnessAdapter({
    binary: fake.binary,
    store,
    codexHome: path.join(fake.directory, "codex-home"),
  })
  try {
    const session = await adapter.createSession(fake.directory)
    const binding = executionBinding(session.id, fake.directory, "native:codex")
    let turnStarted!: () => void
    const streaming = new Promise<void>((resolve) => { turnStarted = resolve })
    // The fake leaves this turn `inProgress` until it is interrupted.
    const turn = (async () => {
      for await (const _event of executeTestTurn(adapter, session.id, prompt("start the work", "1"), fake.directory)) {
        turnStarted()
      }
    })()
    // The driver records the app-server's turn id while projecting the same
    // notification that produces this first frame.
    await streaming
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(await adapter.steerTurn(binding, prompt("also update the readme", "2"))).toEqual({ ok: true })

    const steers = (await requests(fake.log)).filter((request) => request.method === "turn/steer")
    expect(steers).toEqual([{ method: "turn/steer", expectedTurnId: "turn-1" }])
    await cancelAdapterTurn(adapter, binding)
    await turn
  } finally {
    await adapter.dispose()
    await fs.rm(fake.directory, { recursive: true, force: true })
  }
})

test("steering a session with no running turn is refused rather than starting one", async () => {
  const fake = await installFakeCodexAppServer()
  const store = createMemoryRuntimeStore()
  const adapter = new CodexHarnessAdapter({
    binary: fake.binary,
    store,
    codexHome: path.join(fake.directory, "codex-home"),
  })
  try {
    const session = await adapter.createSession(fake.directory)
    const result = await adapter.steerTurn(executionBinding(session.id, fake.directory, "native:codex"), prompt("late", "3"))
    expect(result).toEqual({ ok: false, status: "no_active_turn", message: `Session ${session.id} has no running turn` })
    expect((await requests(fake.log)).map((request) => request.method)).not.toContain("turn/steer")
  } finally {
    await adapter.dispose()
    await fs.rm(fake.directory, { recursive: true, force: true })
  }
})

async function requests(log: string): Promise<Array<{ method: string; expectedTurnId?: string }>> {
  const content = await fs.readFile(log, "utf8").catch(() => "")
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

