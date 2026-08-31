import { describe, expect, test } from "bun:test"
import { getModel } from "@mariozechner/pi-ai"
import { createRuntimeEventHub } from "../../runtime-event-hub"
import { createMemoryRuntimeStore } from "../../stores/memory"
import type { AgentRuntimeStoreWithRecovery } from "../shared/runtime-store"
import { piWorkerStream } from "./test-worker-stream"
import { PiHarnessAdapter } from "."

async function waitUntil(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 2_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function configuredAdapter(input: ConstructorParameters<typeof PiHarnessAdapter>[0]) {
  const adapter = new PiHarnessAdapter(input)
  await adapter.bindSession({ id: "session-1", directory: "/repo" })
  await adapter.updateSessionConfig("session-1", {
    model: { providerID: "openai-codex", modelID: "gpt-5.1-codex-mini" },
  }, "/repo")
  return adapter
}

describe("Pi owned Goal lifecycle", () => {
  test("uses an independent evaluator and enqueues a real follow-up until completion", async () => {
    const model = getModel("openai-codex", "gpt-5.1-codex-mini")
    const workerCalls: string[] = []
    const evaluations: string[] = []
    const runtimeGoals: Array<string | null> = []
    const eventHub = createRuntimeEventHub()
    eventHub.subscribeRuntime((event) => {
      if (event.payload.type === "goal-updated") runtimeGoals.push(event.payload.goal.status)
      if (event.payload.type === "goal-cleared") runtimeGoals.push(null)
    })
    const adapter = await configuredAdapter({
      eventHub,
      modelBackend: () => ({
        model,
        getApiKey: () => "test-key",
        streamFn: piWorkerStream(["first attempt", "verified result"], workerCalls),
      }),
      evaluateGoal: async ({ work }) => {
        evaluations.push(work)
        return work === "verified result"
          ? { met: true, reason: "Evidence is present" }
          : { met: false, reason: "Missing verification" }
      },
    })

    expect((await adapter.readHarnessCapabilities("/repo", { sessionId: "session-1" })).goals).toBe(true)
    expect(await adapter.goals.readCapabilities("session-1", "/repo")).toMatchObject({
      available: true,
      actions: ["pause", "resume", "delete"],
      recovery: "blocked",
    })
    const started = await adapter.goals.start("session-1", { objective: "Ship verified work" }, "/repo")
    expect(started).toMatchObject({ ok: true, goal: { status: "active", iteration: 0 } })

    await waitUntil(() => runtimeGoals.includes("complete"), "Pi Goal completion")
    expect(workerCalls).toHaveLength(2)
    expect(workerCalls[1]).toContain("Independent evaluator: Missing verification")
    expect(evaluations).toEqual(["first attempt", "verified result"])
    expect(await adapter.goals.read("session-1", "/repo")).toMatchObject({
      objective: "Ship verified work",
      status: "complete",
      iteration: 2,
      lastReason: "Evidence is present",
    })
    expect(runtimeGoals).toEqual(["active", "active", "complete"])

    await expect(adapter.goals.delete("session-1", "/repo")).resolves.toEqual({ ok: true, goal: null })
    expect(runtimeGoals.at(-1)).toBeNull()
    adapter.dispose()
  })

  test("Pause disables follow-ups before abort and Resume continues once", async () => {
    const model = getModel("openai-codex", "gpt-5.1-codex-mini")
    const workerCalls: string[] = []
    let evaluationStarted = false
    let evaluationCalls = 0
    const adapter = await configuredAdapter({
      modelBackend: () => ({
        model,
        getApiKey: () => "test-key",
        streamFn: piWorkerStream(["pause here", "resume result"], workerCalls),
      }),
      evaluateGoal: async ({ signal }) => {
        evaluationCalls++
        if (evaluationCalls > 1) return { met: true, reason: "Finished after resume" }
        evaluationStarted = true
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("evaluation aborted")), { once: true })
        })
        return { met: false, reason: "unreachable" }
      },
    })

    await adapter.goals.start("session-1", { objective: "Pause safely" }, "/repo")
    await waitUntil(() => evaluationStarted, "first evaluation")
    const paused = await adapter.goals.pause("session-1", "/repo")
    expect(paused).toMatchObject({ ok: true, goal: { status: "paused" } })
    expect(workerCalls).toHaveLength(1)
    expect(await adapter.goals.read("session-1", "/repo")).toMatchObject({ status: "paused" })

    await adapter.goals.resume("session-1", "/repo")
    await waitUntil(() => workerCalls.length === 2, "resumed Pi turn")
    await waitUntil(async () => (await adapter.goals.read("session-1", "/repo"))?.status === "complete", "resumed completion")
    expect(workerCalls).toHaveLength(2)
    expect(evaluationCalls).toBe(2)
    adapter.dispose()
  })

  test("marks persisted active state blocked because Pi conversation state is not durable", async () => {
    const model = getModel("openai-codex", "gpt-5.1-codex-mini")
    const store = createMemoryRuntimeStore() as unknown as AgentRuntimeStoreWithRecovery
    const first = await configuredAdapter({
      goalStore: store,
      modelBackend: () => ({
        model,
        getApiKey: () => "test-key",
        streamFn: piWorkerStream(["work"], []),
      }),
      evaluateGoal: async ({ signal }) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        })
        return { met: false, reason: "unreachable" }
      },
    })
    await first.goals.start("session-1", { objective: "Survive restart" }, "/repo")
    first.dispose()

    const second = await configuredAdapter({ goalStore: store })
    expect(await second.goals.read("session-1", "/repo")).toMatchObject({
      objective: "Survive restart",
      status: "blocked",
      lastReason: expect.stringContaining("not recoverable"),
    })
    second.dispose()
  })

  test("a central session's Goal update publishes with the canonical central directory scope", async () => {
    const model = getModel("openai-codex", "gpt-5.1-codex-mini")
    const eventHub = createRuntimeEventHub()
    const goalScopes: string[] = []
    eventHub.subscribeRuntime((event) => {
      if (event.payload.type === "goal-updated" || event.payload.type === "goal-cleared") {
        goalScopes.push(event.directory)
      }
    })
    const adapter = new PiHarnessAdapter({
      eventHub,
      modelBackend: () => ({
        model,
        getApiKey: () => "test-key",
        streamFn: piWorkerStream(["verified result"], []),
      }),
      evaluateGoal: async ({ work }) =>
        work === "verified result" ? { met: true, reason: "Evidence is present" } : { met: false, reason: "Missing" },
    })
    // A central Pi session is bound with no directory, mirroring bindSession's
    // canonical '' scope (a Session id is never a directory).
    await adapter.bindSession({ id: "central-session" })
    await adapter.updateSessionConfig("central-session", {
      model: { providerID: "openai-codex", modelID: "gpt-5.1-codex-mini" },
    }, "")

    await adapter.goals.start("central-session", { objective: "Ship centrally" }, "")
    await waitUntil(() => goalScopes.length > 0, "central Goal publish")

    expect(goalScopes.every((scope) => scope === "")).toBe(true)
    adapter.dispose()
  })
})
