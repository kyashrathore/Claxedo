import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { runtimeSnapshot } from "@claxedo/agent-event-runtime"
import type { HarnessInstructionChannel } from "@claxedo/agent-runtime-contract"
import { createAgentRuntime, type AgentHarnessFactory } from "./index"
import { SdkRuntimeAdapter, type SdkRuntimeDriver } from "./harnesses/shared/sdk-runtime-adapter"
import { createSqliteRuntimeStore } from "./stores/sqlite"
import { admitSessionInstructions, SESSION_INSTRUCTIONS_MAX_BYTES } from "./session-instructions"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "session-instructions-"))
  roots.push(root)
  return root
}

type Deliveries = {
  /** The `system` each `createAgentSession` was given, in order. */
  creates: Array<string | undefined>
  /** The `system` each turn was given, in order. */
  turns: Array<string | undefined>
}

/**
 * A driver that records only where the block arrived. Exercising the real
 * `SdkRuntimeAdapter` over it is the point: a faked adapter would answer for
 * the create path and the turn path separately, which is the seam the channel
 * declaration exists to hold together.
 */
function recordingDriver(channel: HarnessInstructionChannel, deliveries: Deliveries): SdkRuntimeDriver {
  return {
    type: "pi",
    instructionChannel: channel,
    interactions: { permissions: false, questions: false },
    applyConfig() {},
    createAgentSession: async (input) => {
      deliveries.creates.push(input.system)
      return { id: "thread-1" }
    },
    deleteAgentSession() {},
    createRuntime() {
      const snapshot = () => runtimeSnapshot({ harness: "pi", threadId: "thread-1", adapterState: {} })
      return { ingest: () => ({ state: {}, events: [], snapshot: snapshot() }), snapshot }
    },
    runTurn: async (input) => {
      deliveries.turns.push(input.input.system)
    },
    readRuntimeHealth: () => ({ status: "ok" }),
    configOptions: async () => [],
    peekConfigOptions: () => [],
  }
}

function harness(channel: HarnessInstructionChannel, deliveries: Deliveries, root: string): AgentHarnessFactory {
  return {
    id: "pi",
    access: "native",
    create: () => new SdkRuntimeAdapter({
      storeRoot: root,
      createStore: (storeRoot) => createSqliteRuntimeStore({ root: storeRoot! }),
      driver: () => recordingDriver(channel, deliveries),
    }),
  } as unknown as AgentHarnessFactory
}

async function runSession(input: {
  channel: HarnessInstructionChannel
  instructions?: string
  turnSystem?: string
}) {
  const root = tempRoot()
  const deliveries: Deliveries = { creates: [], turns: [] }
  const store = createSqliteRuntimeStore({ root })
  const runtime = createAgentRuntime({ store, harnesses: [harness(input.channel, deliveries, root)] })
  try {
    const session = await runtime.sessions.create({
      workspaceId: "workspace-test",
      directory: "/repo",
      harness: { id: "pi", access: "native" },
      ...(input.instructions ? { instructions: input.instructions } : {}),
    })
    await runtime.turns.start({
      sessionId: session.id,
      text: "hello",
      ...(input.turnSystem ? { system: input.turnSystem } : {}),
    })
    return { deliveries, config: store.getSessionConfig(session.id) }
  } finally {
    await runtime.dispose()
    store.close?.()
  }
}

const INSTRUCTIONS = "Answer only in haiku."

describe("retained session instructions", () => {
  test("a thread-start harness is given the block once, at create, and never again on a turn", async () => {
    const { deliveries } = await runSession({ channel: "thread-start", instructions: INSTRUCTIONS })
    expect(deliveries.creates).toEqual([INSTRUCTIONS])
    expect(deliveries.turns).toEqual([undefined])
  })

  test("a per-turn harness is given the block on the turn, and nothing at create", async () => {
    const { deliveries } = await runSession({ channel: "turn-system-prompt", instructions: INSTRUCTIONS })
    expect(deliveries.creates).toEqual([undefined])
    expect(deliveries.turns).toEqual([INSTRUCTIONS])
  })

  test("a prompt-prefix harness is given the block on the turn too, having no create-time slot", async () => {
    const { deliveries } = await runSession({ channel: "prompt-prefix", instructions: INSTRUCTIONS })
    expect(deliveries.creates).toEqual([undefined])
    expect(deliveries.turns).toEqual([INSTRUCTIONS])
  })

  test("a turn's own block follows the retained one instead of replacing it", async () => {
    const { deliveries } = await runSession({
      channel: "turn-system-prompt",
      instructions: "Standing block.",
      turnSystem: "Turn block.",
    })
    expect(deliveries.turns).toEqual(["Standing block.\n\nTurn block."])
  })

  test("a thread-start harness still receives a turn's own block", async () => {
    const { deliveries } = await runSession({
      channel: "thread-start",
      instructions: "Standing block.",
      turnSystem: "Turn block.",
    })
    expect(deliveries.creates).toEqual(["Standing block."])
    expect(deliveries.turns).toEqual(["Turn block."])
  })

  test("the retained block survives a runtime restart and reaches the next turn", async () => {
    const root = tempRoot()
    const deliveries: Deliveries = { creates: [], turns: [] }
    let store = createSqliteRuntimeStore({ root })
    let runtime = createAgentRuntime({ store, harnesses: [harness("turn-system-prompt", deliveries, root)] })
    let sessionId: string
    try {
      sessionId = (await runtime.sessions.create({
        workspaceId: "workspace-test",
        directory: "/repo",
        harness: { id: "pi", access: "native" },
        instructions: INSTRUCTIONS,
      })).id
    } finally {
      await runtime.dispose()
      store.close?.()
    }

    store = createSqliteRuntimeStore({ root })
    runtime = createAgentRuntime({ store, harnesses: [harness("turn-system-prompt", deliveries, root)] })
    try {
      expect(store.getSessionConfig(sessionId)).toMatchObject({ instructions: INSTRUCTIONS })
      await runtime.turns.start({ sessionId, text: "hello" })
      expect(deliveries.turns).toEqual([INSTRUCTIONS])
    } finally {
      await runtime.dispose()
      store.close?.()
    }
  })

  test("a harness with no instruction channel refuses the create instead of dropping the block", async () => {
    await expect(runSession({ channel: "none", instructions: INSTRUCTIONS }))
      .rejects.toMatchObject({ detail: { code: "unsupported_operation", operation: "session_instructions" } })
  })
})

describe("admitSessionInstructions", () => {
  test("admits an absent block on every channel, including one with no channel at all", () => {
    for (const channel of ["turn-system-prompt", "thread-start", "prompt-prefix", "none"] as const) {
      expect(admitSessionInstructions({ channel, instructions: undefined })).toBeUndefined()
    }
  })

  test("refuses by byte count, not character count", () => {
    const atCap = "🙂".repeat(SESSION_INSTRUCTIONS_MAX_BYTES / 4)
    expect(admitSessionInstructions({ channel: "thread-start", instructions: atCap })).toBeUndefined()
    expect(admitSessionInstructions({ channel: "thread-start", instructions: `${atCap}a` }))
      .toMatchObject({ reason: "too_large" })
  })

  test("names the harness it was asked for when the caller knows it", () => {
    expect(admitSessionInstructions({ harness: "opencode", channel: "none", instructions: "x" })?.message)
      .toBe("Harness opencode has no instruction channel for session instructions")
    expect(admitSessionInstructions({ channel: "none", instructions: "x" })?.message)
      .toBe("This harness has no instruction channel for session instructions")
  })
})
