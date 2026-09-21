import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { createRuntimeEventHub } from "../../runtime-event-hub"
import { cancelAdapterTurn } from "../../test-utils/cancel-turn"
import { executeTestTurn, executionBinding } from "../../test-utils/execution-binding"
import { installFakeCodexAppServer } from "../../test-utils/fake-codex-app-server"
import { CodexHarnessAdapter } from "./index"

for (const terminateFails of [false, true]) {
  for (const goalMode of [false, true]) {
  test(`${goalMode ? "Goal " : ""}${terminateFails ? "Stop reports terminal cleanup failure" : "Stop awaits cleanup of only its turn across terminal pages"}`, async () => {
    const fake = await installFakeCodexAppServer({ command: true, terminateFails })
    const store = createMemoryRuntimeStore()
    const eventHub = createRuntimeEventHub()
    const events: unknown[] = []
    eventHub.subscribeRuntime((event) => events.push(event.payload))
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      store,
      eventHub,
      codexHome: path.join(fake.directory, "codex-home"),
    })
    let commandStarted!: () => void
    const started = new Promise<void>((resolve) => { commandStarted = resolve })
    try {
      const session = await adapter.createSession(fake.directory)
      const turn = goalMode ? (async () => {
        expect(await adapter.goals!.start(session.id, { objective: "hold-turn command" }, fake.directory)).toMatchObject({ ok: true })
        for (let attempt = 0; attempt < 100 && !JSON.stringify(store.getMessages(session.id)).includes("cmd-current"); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(JSON.stringify(store.getMessages(session.id))).toContain("cmd-current")
        commandStarted()
      })() : (async () => {
        for await (const event of executeTestTurn(adapter, session.id, {
          parts: [{ type: "text", text: "Run a command" }],
          userMessageId: "user-1",
          assistantMessageId: "assistant-1",
          agent: "build",
          model: { providerID: "codex", modelID: "default" },
        }, fake.directory)) {
          if (JSON.stringify(event).includes("cmd-current")) commandStarted()
        }
      })()
      await started
      const stopping = goalMode ? adapter.goals!.stop(session.id, fake.directory) : cancelAdapterTurn(adapter, executionBinding(session.id, fake.directory, "native:codex"))
      if (terminateFails) {
        // Codex named a live terminal for this turn and then refused to
        // terminate it, so the turn's fate upstream is unknown and the
        // terminal is still owned.
        await expect(stopping).resolves.toMatchObject(goalMode
          ? { ok: false, status: "failed", message: expect.stringContaining("terminal cleanup failed") }
          : { execution: "unknown", cleanup: "owned", error: { code: "provider_unreachable", message: "terminal cleanup failed" } })
      } else {
        // Codex's terminal inventory no longer lists this turn's command, and
        // Codex runs its tools nowhere else, so the turn's resources are clear.
        await expect(stopping).resolves.toMatchObject(goalMode ? { ok: true, goal: { status: "paused" } } : { execution: "terminal", cleanup: "verified_clear" })
        expect(await fs.readFile(fake.goalFile + ".terminated", "utf8")).toBe("process-current")
      }
      await turn
      if (!terminateFails) {
        for (let attempt = 0; attempt < 100 && !events.some((event) => JSON.stringify(event) === JSON.stringify({ type: "session-status", status: "idle" })); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(events).toContainEqual({ type: "session-status", status: "idle" })
      }
      const requests = (await fs.readFile(fake.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      expect(requests.filter((request) => request.method === "thread/backgroundTerminals/terminate"))
        .toEqual([{ method: "thread/backgroundTerminals/terminate", processId: "process-current" }])
    } finally {
      await adapter.dispose()
      await fs.rm(fake.directory, { recursive: true, force: true })
    }
  })
  }
}

test("a terminal Codex acknowledged terminating and still lists is owned, not clear", async () => {
  const fake = await installFakeCodexAppServer({ command: true, terminalSurvives: true })
  const store = createMemoryRuntimeStore()
  const adapter = new CodexHarnessAdapter({
    binary: fake.binary,
    store,
    eventHub: createRuntimeEventHub(),
    codexHome: path.join(fake.directory, "codex-home"),
  })
  let commandStarted!: () => void
  const started = new Promise<void>((resolve) => { commandStarted = resolve })
  try {
    const session = await adapter.createSession(fake.directory)
    const turn = (async () => {
      for await (const event of executeTestTurn(adapter, session.id, {
        parts: [{ type: "text", text: "Run a command" }],
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        agent: "build",
        model: { providerID: "codex", modelID: "default" },
      }, fake.directory)) {
        if (JSON.stringify(event).includes("cmd-current")) commandStarted()
      }
    })()
    await started
    // Every terminate was acknowledged, so nothing failed — and Codex's own
    // inventory still lists this turn's process, which is what decides.
    await expect(cancelAdapterTurn(adapter, executionBinding(session.id, fake.directory, "native:codex")))
      .resolves.toMatchObject({ execution: "terminal", cleanup: "owned" })
    await turn
  } finally {
    await adapter.dispose()
    await fs.rm(fake.directory, { recursive: true, force: true })
  }
})

/** One prompt turn on a fake app-server, stopped once its command is running. */
async function stopTurnOn(options: Parameters<typeof installFakeCodexAppServer>[0]) {
  const fake = await installFakeCodexAppServer({ command: true, ...options })
  const adapter = new CodexHarnessAdapter({
    binary: fake.binary,
    store: createMemoryRuntimeStore(),
    eventHub: createRuntimeEventHub(),
    codexHome: path.join(fake.directory, "codex-home"),
  })
  let commandStarted!: () => void
  const started = new Promise<void>((resolve) => { commandStarted = resolve })
  try {
    const session = await adapter.createSession(fake.directory)
    const turn = (async () => {
      for await (const event of executeTestTurn(adapter, session.id, {
        parts: [{ type: "text", text: "Run a command" }],
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        agent: "build",
        model: { providerID: "codex", modelID: "default" },
      }, fake.directory)) {
        // Either the turn's own command or the one its subagent thread ran:
        // both mean the provider is far enough along to be stopped.
        // Either the turn's own command, or the marker the fake emits once a
        // subagent thread's command is running.
        if (JSON.stringify(event).includes("cmd-current") || JSON.stringify(event).includes("child-command-running")) commandStarted()
      }
    })()
    await started
    const outcome = await cancelAdapterTurn(adapter, executionBinding(session.id, fake.directory, "native:codex"))
    await turn
    return outcome
  } finally {
    await adapter.dispose()
    await fs.rm(fake.directory, { recursive: true, force: true })
  }
}

test("a subagent thread's terminal is enumerated on its own inventory and verified with the rest", async () => {
  // This turn never watched the child's command start, so the local record of
  // observed commands is empty for it. The child thread's own inventory is
  // where it is found, terminated, and read back gone.
  expect(await stopTurnOn({ childCommand: true })).toMatchObject({ execution: "terminal", cleanup: "verified_clear" })
})

test("a turn that ran no command of its own still enumerates the thread it spawned", async () => {
  // Nothing was recorded locally for this turn, which is exactly the state an
  // empty-map shortcut reads as proof. The child thread it owns is holding a
  // terminal, and only the inventory says so.
  expect(await stopTurnOn({ childCommandOnly: true, terminalSurvives: true })).toMatchObject({ cleanup: "owned" })
})

test("a subagent thread's terminal that survives its termination holds the turn at owned", async () => {
  expect(await stopTurnOn({ childCommand: true, terminalSurvives: true })).toMatchObject({ cleanup: "owned" })
})

test("a terminal inventory this owner could not read leaves cleanup unknown, never clear", async () => {
  expect(await stopTurnOn({ listFails: true })).toMatchObject({
    cleanup: "unknown",
    execution: "unknown",
    error: { code: "provider_unreachable", message: "terminal inventory is unavailable" },
  })
})

test("a turn that owns a subagent thread whose inventory cannot be read is unknown, never clear", async () => {
  // The parent's own terminals were found and terminated; the child thread's
  // inventory never answered, so nothing establishes what the turn still holds.
  expect(await stopTurnOn({ childCommand: true, listFailsOnSecondRead: true })).toMatchObject({ cleanup: "unknown" })
})
