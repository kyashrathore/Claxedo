import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { installFakePiRpc } from "../test-utils/fake-pi-rpc.mjs"
import {
  GoalCapabilityError,
  goalActionAvailable,
  goalCapabilities,
  requireGoalAction,
} from "../capabilities"
import {
  requireGoalResource,
  type AgentGoalResource,
  type AgentHarnessAdapter,
} from "../adapter-contract"
import { createMemoryRuntimeStore } from "../stores/memory"
import { installFakeCodexAppServer } from "../test-utils/fake-codex-app-server"
import { removeTestTempDir } from "./shared/test-temp-dir"
import { SdkRuntimeAdapter } from "./shared/sdk-runtime-adapter"
import { CodexHarnessAdapter } from "./codex"
import { createClaudeSdkDriver } from "./claude/driver"
import { createCursorSdkDriver } from "./cursor/driver"
import { PiHarnessAdapter } from "./pi"
import type { Query } from "@anthropic-ai/claude-agent-sdk"

const objective = "Ship when verification passes"

type ConformanceHarness = {
  goals: AgentGoalResource
  sessionId: string
  directory: string
  /** Awaited after start so provider-side continuation settles before mutations. */
  settle?: () => Promise<void>
  dispose(): void
}

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) removeTestTempDir(directory)
})

async function codexHarness(): Promise<ConformanceHarness> {
  const fake = await installFakeCodexAppServer()
  tempDirs.push(fake.directory)
  const adapter = new CodexHarnessAdapter({
    binary: fake.binary,
    store: createMemoryRuntimeStore(),
    codexHome: path.join(fake.directory, "codex-home"),
  })
  const session = await adapter.createSession(fake.directory, undefined, "session-conformance")
  return {
    goals: adapter.goals!,
    sessionId: session.id,
    directory: fake.directory,
    dispose: () => adapter.dispose(),
  }
}

async function claudeHarness(): Promise<ConformanceHarness> {
  const fakeQuery = ((input: {
    prompt: string
    options: {
      sessionStore: { append(key: { projectKey: string; sessionId: string }, entries: unknown[]): Promise<void> }
    }
  }) => {
    const stream = (async function* () {
      if (input.prompt === "/goal clear") {
        yield { type: "result", subtype: "success", is_error: false, num_turns: 0 }
        return
      }
      yield { type: "system", subtype: "init", session_id: "claude-session" }
      await input.options.sessionStore.append(
        { projectKey: "/repo", sessionId: "claude-session" },
        [{
          type: "attachment",
          timestamp: "2023-11-14T22:13:20.000Z",
          attachment: { type: "goal_status", met: false, condition: objective, reason: "One test remains" },
        }],
      )
    })()
    return Object.assign(stream, { close() {} }) as unknown as Query
  }) as never
  const adapter = new SdkRuntimeAdapter({
    store: createMemoryRuntimeStore(),
    driver: (host) => createClaudeSdkDriver(host, {
      query: fakeQuery,
      executable: () => "/fake/claude",
    }),
  })
  const session = await adapter.createSession("/repo", undefined, "session-conformance")
  return {
    goals: adapter.goals!,
    sessionId: session.id,
    directory: "/repo",
    dispose: () => adapter.dispose(),
  }
}

async function cursorHarness(): Promise<ConformanceHarness> {
  // Claxedo projects no Cursor credential; the driver reads the machine's own.
  process.env.CURSOR_API_KEY = "cursor-conformance-key"
  const makeRun = () => {
    let release = () => {}
    const cancelled = new Promise<void>((resolve) => { release = resolve })
    return {
      id: "run-1",
      async *stream() { await cancelled },
      wait: async () => ({ id: "run-1", status: "cancelled" as const }),
      cancel: async () => release(),
    }
  }
  const agent = {
    agentId: "cursor-agent-1",
    model: undefined,
    send: async () => makeRun(),
    close() {},
    reload: async () => {},
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.from([]),
    [Symbol.asyncDispose]: async () => {},
  }
  const adapter = new SdkRuntimeAdapter({
    store: createMemoryRuntimeStore(),
    driver: (host) => createCursorSdkDriver(host, {
      loadAgent: async () => ({
        Agent: { create: async () => agent, resume: async () => agent } as never,
      }),
    }),
  })
  const session = await adapter.createSession("/repo", undefined, "session-conformance")
  return {
    goals: adapter.goals!,
    sessionId: session.id,
    directory: "/repo",
    dispose: () => adapter.dispose(),
  }
}

async function piHarness(): Promise<ConformanceHarness> {
  const fake = await installFakePiRpc()
  tempDirs.push(fake.directory)
  await fs.writeFile(path.join(fake.directory, "hold-evaluator"), "yes")
  const store = createMemoryRuntimeStore()
  const adapter = new PiHarnessAdapter({ binary: fake.binary, agentDir: fake.agentDir, store })
  const session = await adapter.createSession(fake.directory)
  const nativeId = store.getAgentSessionId(session.id)
  store.updateSessionConfig(session.id, await adapter.updateSessionConfig({ sessionId: session.id, directory: fake.directory, workspaceId: "workspace", connectionId: "native:pi", upstreamSessionId: nativeId! }, { model: { providerID: "pi", modelID: "test/model" } }))
  return {
    goals: adapter.goals!, sessionId: session.id, directory: fake.directory,
    settle: async () => {
      const deadline = Date.now() + 5000
      while (!await fs.stat(path.join(fake.directory, "evaluating")).then(() => true, () => false)) {
        if (Date.now() > deadline) throw new Error("Pi evaluator did not start")
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    },
    dispose: () => adapter.dispose(),
  }
}

/**
 * Every built-in Goal adapter runs the SAME lifecycle below against its real
 * implementation over a scripted provider. Assertions branch only on the
 * capabilities each adapter itself advertises, so an adapter cannot pass by
 * hard-coding the suite's expectations.
 *
 * Not in the table: ACP (process-backed; its Goal extension is covered by
 * acp/goal-extension.test.ts) and OpenCode (the embedded backend is being
 * removed). Provider-loss recovery is covered by goal-recovery.test.ts.
 */
const builtins: Array<{ id: string; make: () => Promise<ConformanceHarness> }> = [
  { id: "codex", make: codexHarness },
  { id: "claude", make: claudeHarness },
  { id: "cursor", make: cursorHarness },
  { id: "pi", make: piHarness },
]

describe("Goal resource conformance", () => {
  for (const builtin of builtins) {
    test(`${builtin.id} start, pause/interrupt, resume identity, stop, and delete honor advertised capabilities`, async () => {
      const harness = await builtin.make()
      const { goals, sessionId, directory } = harness
      try {
        const capabilities = await goals.readCapabilities(sessionId, directory)
        expect(capabilities.implemented).toBe(true)
        expect(capabilities.available).toBe(true)

        expect(await goals.read(sessionId, directory)).toBeNull()

        const started = await goals.start(sessionId, { objective }, directory)
        if (!started.ok) throw new Error(`start failed: ${started.message}`)
        expect(started.goal).toMatchObject({ sessionId, objective, status: "active" })
        const createdAt = started.goal.createdAt
        await harness.settle?.()
        expect(await goals.read(sessionId, directory)).toMatchObject({ sessionId, objective })

        if (goalActionAvailable(capabilities, "pause")) {
          const paused = await goals.pause(sessionId, directory)
          expect(paused).toMatchObject({ ok: true, goal: { status: "paused" } })
          const resumed = await goals.resume(sessionId, directory)
          expect(resumed).toMatchObject({ ok: true, goal: { status: "active", objective } })
          // Resume must continue the SAME Goal, not mint a replacement.
          expect(resumed.ok && resumed.goal.createdAt).toBe(createdAt)
        } else {
          expect(() => requireGoalAction(capabilities, "pause")).toThrow(GoalCapabilityError)
          expect(await goals.pause(sessionId, directory)).toMatchObject({ ok: false })
          expect(await goals.resume(sessionId, directory)).toMatchObject({ ok: false })
        }

        const stopped = await goals.stop(sessionId, directory)
        expect(stopped.ok).toBe(true)
        if (stopped.ok && stopped.goal) expect(stopped.goal.status).toBe("paused")

        if (goalActionAvailable(capabilities, "delete")) {
          expect(await goals.delete(sessionId, directory)).toEqual({ ok: true, goal: null })
          expect(await goals.read(sessionId, directory)).toBeNull()
        } else {
          expect(() => requireGoalAction(capabilities, "delete")).toThrow(GoalCapabilityError)
          expect(await goals.delete(sessionId, directory)).toMatchObject({ ok: false })
          // The stopped Goal must survive the refused delete untouched.
          expect(await goals.read(sessionId, directory)).toMatchObject({ objective })
        }
      } finally {
        harness.dispose()
      }
    })
  }

  test("rejects an adapter without SupportsGoals before ordinary message dispatch", () => {
    let messagesSent = 0
    const adapter = {
      sendMessage: () => {
        messagesSent += 1
      },
    } as unknown as AgentHarnessAdapter

    expect(() => requireGoalResource(adapter)).toThrow(GoalCapabilityError)
    expect(messagesSent).toBe(0)
  })

  test("treats Pause and Resume as one reversible capability pair", () => {
    const incomplete = goalCapabilities({
      implemented: true,
      available: true,
      actions: ["pause", "delete"],
      recovery: "blocked",
      optionalFields: [],
    })

    expect(goalActionAvailable(incomplete, "pause")).toBe(false)
    expect(goalActionAvailable(incomplete, "resume")).toBe(false)
    expect(goalActionAvailable(incomplete, "delete")).toBe(true)
    expect(() => requireGoalAction(incomplete, "resume")).toThrow(GoalCapabilityError)
  })

  test("requires an unavailable implementation to report why", () => {
    expect(() => goalCapabilities({
      implemented: true,
      available: false,
      actions: [],
      recovery: "blocked",
      optionalFields: [],
    })).toThrow("unavailableReason")
  })
})
