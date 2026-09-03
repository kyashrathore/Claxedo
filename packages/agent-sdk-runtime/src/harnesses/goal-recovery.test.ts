import { describe, expect, test } from "bun:test"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { createMemoryRuntimeStore } from "../stores/memory"
import { storeRows } from "../test-utils/store-internals"
import { ClaudeHarnessAdapter } from "./claude"
import { CursorHarnessAdapter } from "./cursor"

describe("native Goal recovery matrix", () => {
  for (const entry of [
    {
      id: "claude" as const,
      available: true,
      create: (store: ReturnType<typeof storeRows>) => new ClaudeHarnessAdapter({ store }),
    },
    {
      id: "cursor" as const,
      available: false,
      create: (store: ReturnType<typeof storeRows>) => new CursorHarnessAdapter({ store }),
    },
  ]) {
    test(`${entry.id} exposes persisted provider-loss as blocked instead of complete`, async () => {
      const store = storeRows(createMemoryRuntimeStore())
      const sessionId = `${entry.id}-session`
      const directory = "/repo"
      store.bindSession({ sessionId, directory, agentSessionId: `${entry.id}-provider-session` })
      store.updateSessionConfig(sessionId, {
        harness: { id: entry.id, access: "native" },
        model: { providerID: entry.id, modelID: "default" },
        agent: "build",
        variant: null,
      })
      const persisted: RuntimeGoalSnapshot = {
        sessionId,
        objective: "Recover without inventing completion",
        status: "active",
        createdAt: 10,
        updatedAt: 20,
      }
      expect(store.setGoal).toBeFunction()
      store.setGoal?.(sessionId, persisted)

      const adapter = entry.create(store)
      // Only an AVAILABLE driver advertises the delete this resource can
      // perform; `goalActionAvailable` denies every action on an unavailable
      // capability, so advertising one there would be a choice nothing honors.
      expect(await adapter.goals!.readCapabilities(sessionId, directory)).toMatchObject({
        implemented: true,
        available: entry.available,
        actions: entry.available ? ["delete"] : [],
        recovery: "blocked",
      })
      expect(await adapter.goals!.read(sessionId, directory)).toEqual({
        ...persisted,
        status: "blocked",
        updatedAt: expect.any(Number),
      })
      expect((await adapter.goals!.read(sessionId, directory))?.status).not.toBe("complete")
      adapter.dispose()
    })
  }
})
