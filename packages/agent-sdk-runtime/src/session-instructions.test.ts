import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAgentRuntime, type AgentHarnessFactory } from "./index"
import type { AgentHarnessAdapter, AgentSessionCreateOptions } from "./adapters"
import { createSqliteRuntimeStore } from "./stores/sqlite"
import { messagePartUpdated } from "./compat-events"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "session-instructions-"))
  roots.push(root)
  return root
}

function harness(input: {
  instructionChannel: boolean
  creates?: AgentSessionCreateOptions[]
  turnSystems?: Array<string | undefined>
}): AgentHarnessFactory {
  const adapter: AgentHarnessAdapter = {
    ...(input.instructionChannel ? { adapterCapabilities: ["session-instructions"] as const } : {}),
    sessionConfigOwner: "runtime",
    async getSession(binding) { return { id: binding.sessionId } },
    async createSession(_directory, _title, id = "ses_instructions", options = {}) {
      input.creates?.push(options)
      return { id }
    },
    async updateSession() { return null },
    async getSessionConfig() { return { harness: { id: "pi" as const, access: "native" as const }, variant: null, agent: null } },
    async updateSessionConfig() { return { harness: { id: "pi" as const, access: "native" as const }, variant: null, agent: null } },
    async deleteSession() {},
    readHarnessCapabilities() { return {} as never },
    async *executeTurn(binding, prompt) {
      input.turnSystems?.push(prompt.system)
      yield messagePartUpdated({
        id: `${binding.sessionId}-part`,
        sessionID: binding.sessionId,
        messageID: prompt.assistantMessageId,
        type: "text",
        text: "ok",
      })
      yield { type: "finish", sessionId: binding.sessionId }
    },
    async getMessages() { return [] },
    dispose() {},
  }
  return { id: "pi", access: "native", create: () => adapter } as unknown as AgentHarnessFactory
}

describe("retained session instructions", () => {
  test("reach the harness at create and on every turn after a runtime restart", async () => {
    const root = tempRoot()
    const creates: AgentSessionCreateOptions[] = []
    const turnSystems: Array<string | undefined> = []
    const instructions = "Answer only in haiku."
    let store = createSqliteRuntimeStore({ root })
    let runtime = createAgentRuntime({ store, harnesses: [harness({ instructionChannel: true, creates, turnSystems })] })
    let sessionId: string
    try {
      const session = await runtime.sessions.create({
        workspaceId: "workspace-test",
        directory: "/repo",
        harness: { id: "pi", access: "native" },
        instructions,
      })
      sessionId = session.id
      expect(creates).toEqual([{ instructions }])
      expect(store.getSessionConfig(sessionId)).toMatchObject({ instructions })
    } finally {
      await runtime.dispose()
      store.close?.()
    }

    store = createSqliteRuntimeStore({ root })
    runtime = createAgentRuntime({ store, harnesses: [harness({ instructionChannel: true, creates, turnSystems })] })
    try {
      expect(store.getSessionConfig(sessionId!)).toMatchObject({ instructions })
      await runtime.turns.start({ sessionId: sessionId!, text: "hello" })
      for (let waited = 0; waited < 50 && turnSystems.length === 0; waited += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(turnSystems).toEqual([instructions])
    } finally {
      await runtime.dispose()
      store.close?.()
    }
  })

  test("a turn's own instruction block follows the retained one instead of replacing it", async () => {
    const turnSystems: Array<string | undefined> = []
    const store = createSqliteRuntimeStore({ root: tempRoot() })
    const runtime = createAgentRuntime({ store, harnesses: [harness({ instructionChannel: true, turnSystems })] })
    try {
      const session = await runtime.sessions.create({
        workspaceId: "workspace-test",
        directory: "/repo",
        harness: { id: "pi", access: "native" },
        instructions: "Standing block.",
      })
      await runtime.turns.start({ sessionId: session.id, text: "hello", system: "Turn block." })
      for (let waited = 0; waited < 50 && turnSystems.length === 0; waited += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(turnSystems).toEqual(["Standing block.\n\nTurn block."])
    } finally {
      await runtime.dispose()
      store.close?.()
    }
  })

  test("a harness with no instruction channel refuses the create instead of dropping the block", async () => {
    const creates: AgentSessionCreateOptions[] = []
    const store = createSqliteRuntimeStore({ root: tempRoot() })
    const runtime = createAgentRuntime({ store, harnesses: [harness({ instructionChannel: false, creates })] })
    try {
      await expect(runtime.sessions.create({
        workspaceId: "workspace-test",
        directory: "/repo",
        harness: { id: "pi", access: "native" },
        instructions: "Answer only in haiku.",
      })).rejects.toMatchObject({ detail: { code: "unsupported_operation", operation: "session_instructions" } })
      expect(creates).toEqual([])
    } finally {
      await runtime.dispose()
      store.close?.()
    }
  })
})
