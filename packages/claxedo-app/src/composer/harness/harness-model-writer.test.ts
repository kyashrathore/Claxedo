import { expect, test } from "bun:test"
import { placementId, projectId, sessionId, type ModelChoice } from "@/server"
import { createHarnessModelWriter } from "./harness-model-writer"
import type { HarnessScopeInput } from "./store-policy"

const sessionRef = { placementId: placementId("w"), projectId: projectId("p"), sessionId: sessionId("s") }
const session: HarnessScopeInput = { placementId: placementId("w"), sessionId: "s", sessionRef }
const opus: ModelChoice = { providerId: "anthropic", modelId: "opus" }
const refusal = (write: Promise<void>) => write.then(() => undefined, (error: Error) => error.message)

function writer() {
  const efforts = new Map<string, string | undefined>([["scope", "low"]])
  const models = new Map<string, ModelChoice>([["scope", { providerId: "anthropic", modelId: "sonnet" }]])
  const sent: string[] = []
  const unanswered: Array<(refusal?: Error) => void> = []
  const request = (write: string) => {
    sent.push(write)
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    unanswered.push((refusal) => (refusal ? reject(refusal) : resolve()))
    return promise
  }
  const written = createHarnessModelWriter<HarnessScopeInput>({
    seed: () => {}, acceptsDraftModel: () => true, currentModel: (scope) => models.get(scope), setSelectedModel: (scope, model) => { models.set(scope, model) },
    holdsHarness: () => false, reloadOptions: () => {}, rememberDraftModel: () => {},
    selectedEffort: (scope) => efforts.get(scope), setSelectedEffort: (scope, effort) => { efforts.set(scope, effort) },
    runtime: { setSessionModel: (_ref, model) => request(`model ${model.modelId}`), setSessionEffort: (_ref, effort) => request(`effort ${effort ?? "default"}`) },
  })
  const answer = async (refusal?: Error) => {
    unanswered.shift()!(refusal)
    await Bun.sleep(0)
  }
  return { written, efforts, models, sent, answer }
}

test("a session's effort, model and submission writes reach the server one at a time, in the order they were made", async () => {
  const { written, sent, answer } = writer()
  const high = written.setEffort("scope", "high", session)
  const model = written.setModel("scope", opus, session)
  const low = written.setEffort("scope", "low", session)
  const commit = written.inOrder("scope", async () => void sent.push("submission"))
  let settled = false
  void written.settledConfig("scope").then(() => (settled = true))
  await Bun.sleep(0)
  expect(sent).toEqual(["effort high"])
  await answer()
  expect(sent).toEqual(["effort high", "model opus"])
  await answer()
  expect(sent).toEqual(["effort high", "model opus", "effort low"])
  expect(settled).toBe(false)
  await answer()
  await Promise.all([high, model, low, commit])
  expect(sent).toEqual(["effort high", "model opus", "effort low", "submission"])
  expect(settled).toBe(true)
})

test("a refused effort write restores the effort the server last confirmed, not an unconfirmed pick", async () => {
  const { written, efforts, answer } = writer()
  const high = refusal(written.setEffort("scope", "high", session))
  const max = refusal(written.setEffort("scope", "max", session))
  await Bun.sleep(0)
  await answer(new Error("session_config_refused"))
  expect(await high).toBe("session_config_refused")
  expect(efforts.get("scope")).toBe("max")
  await answer(new Error("session_config_refused"))
  expect(await max).toBe("session_config_refused")
  expect(efforts.get("scope")).toBe("low")
})

test("a refused model write restores the model the server last confirmed", async () => {
  const { written, models, answer } = writer()
  const haiku = { providerId: "anthropic", modelId: "haiku" }
  const picks = [refusal(written.setModel("scope", opus, session)), refusal(written.setModel("scope", haiku, session))]
  await Bun.sleep(0)
  await answer(new Error("session_config_refused"))
  await answer(new Error("session_config_refused"))
  expect(await Promise.all(picks)).toEqual(["session_config_refused", "session_config_refused"])
  expect(models.get("scope")).toEqual({ providerId: "anthropic", modelId: "sonnet" })
  const confirmed = refusal(written.setModel("scope", opus, session))
  const refused = refusal(written.setModel("scope", haiku, session))
  await Bun.sleep(0)
  await answer()
  await answer(new Error("session_config_refused"))
  expect([await confirmed, await refused]).toEqual([undefined, "session_config_refused"])
  expect(models.get("scope")).toEqual(opus)
})

test("an unchanged effort sends nothing, and a draft's effort stays local", async () => {
  const { written, efforts, sent } = writer()
  await written.setEffort("scope", "low", session)
  await written.setEffort("scope", "high", { placementId: placementId("w"), sessionId: "new" })
  expect(efforts.get("scope")).toBe("high")
  expect(sent).toEqual([])
})
