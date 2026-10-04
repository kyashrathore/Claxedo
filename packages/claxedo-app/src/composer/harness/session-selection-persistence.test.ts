import { expect, test } from "bun:test"
import { placementId, projectId, sessionId, type ModelChoice } from "@/server"
import type { HarnessWiring } from "./harness-wiring"
import { commitSessionSelection } from "./session-harness"

const sessionRef = { placementId: placementId("w"), projectId: projectId("p"), sessionId: sessionId("s") }

test.each(["high", undefined])("a submitted effort %s is persisted, including an explicit default reset", async (variant) => {
  const writes: unknown[] = []
  const model: ModelChoice = { providerId: "claude", modelId: "default", variant }
  const wiring = {
    api: { updateSessionConfig: async (_ref: unknown, patch: unknown) => { writes.push(patch) } },
    store: { heldHarness: () => undefined, harnessModelKeyForSubmit: () => model },
  } as unknown as HarnessWiring
  await commitSessionSelection(wiring, "scope", { sessionRef, sessionModel: () => ({ ...model, variant: "low" }) })
  expect(writes).toEqual([{ variant: variant ?? null }])
  await commitSessionSelection(wiring, "scope", { sessionRef, sessionModel: () => model })
  expect(writes).toHaveLength(1)
})

test("a refused effort write rejects submission without releasing a held harness", async () => {
  let released = false
  const wiring = { api: { updateSessionConfig: async () => { throw new Error("write refused") } },
    store: { heldHarness: () => ({ kind: "native", harnessId: "claude" }), harnessModelKeyForSubmit: () => undefined,
      releaseHeldHarness: () => { released = true } } } as unknown as HarnessWiring
  await expect(commitSessionSelection(wiring, "scope", { sessionRef })).rejects.toThrow("write refused")
  expect(released).toBe(false)
})
