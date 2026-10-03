import { expect, test } from "bun:test"
import { placementId, projectId, sessionId, type ModelChoice } from "@/server"
import { createHarnessModelWriter, type SessionModelSyncState } from "./harness-model-writer"
import type { HarnessScopeInput } from "./store-policy"

const sessionRef = { placementId: placementId("w"), projectId: projectId("p"), sessionId: sessionId("s") }
const session: HarnessScopeInput = { placementId: placementId("w"), sessionId: "s", sessionRef }

function writer(setSessionEffort: (effort: string | undefined) => Promise<void>) {
  const efforts = new Map<string, string | undefined>([["scope", "low"]])
  const states = new Map<string, SessionModelSyncState>()
  const pending = new Map<string, Promise<void>>()
  const written = createHarnessModelWriter<HarnessScopeInput>({
    seed: () => {}, acceptsDraftModel: () => true, currentModel: () => undefined, setSelectedModel: () => {},
    holdsHarness: () => false, reloadOptions: () => {}, rememberDraftModel: () => {},
    selectedEffort: (scope) => efforts.get(scope), setSelectedEffort: (scope, effort) => { efforts.set(scope, effort) },
    runtime: { setSessionModel: async (_ref: unknown, _model: ModelChoice) => {}, setSessionEffort: (_ref, effort) => setSessionEffort(effort) },
    cache: { getState: (key) => states.get(key), setState: (key, value) => { states.set(key, value) },
      getPending: (key) => pending.get(key), setPending: (key, _model, value) => { pending.set(key, value) }, removePending: (key) => { pending.delete(key) } },
  })
  return { written, efforts }
}

test("a session's effort pick writes the session config at once", async () => {
  const writes: (string | undefined)[] = []
  const { written, efforts } = writer(async (effort) => { writes.push(effort) })
  await written.setEffort("scope", "high", session)
  expect(efforts.get("scope")).toBe("high")
  await written.setEffort("scope", "high", session)
  await written.setEffort("scope", undefined, session)
  expect(writes).toEqual(["high", undefined])
})

test("a refused effort write restores the previous effort, and a draft effort stays local", async () => {
  const writes: (string | undefined)[] = []
  const { written, efforts } = writer(async (effort) => { writes.push(effort); throw new Error("session_config_refused") })
  await expect(written.setEffort("scope", "max", session)).rejects.toThrow("session_config_refused")
  expect(efforts.get("scope")).toBe("low")
  await written.setEffort("scope", "high", { placementId: placementId("w"), sessionId: "new" })
  expect(efforts.get("scope")).toBe("high")
  expect(writes).toEqual(["max"])
})
