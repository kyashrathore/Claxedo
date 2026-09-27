/// <reference types="bun" />
import { expect, test } from "bun:test"
import { nativeHarness } from "@/lib/harness-selection"
import { placementId as placement, projectId, sessionId, type SessionRow, type TranscriptMessage } from "@/server"
import { createHarnessHydrator } from "./harness-hydrator"
import { createHarnessStatusActions } from "./harness-status-actions"
import { createHarnessStore } from "./harness-store"
import { createScopeCaches } from "./scope-caches"
import { knownSessionModel, type HarnessScopeInput } from "./store-policy"

const placementId = placement("placement-1")
const pi = nativeHarness("pi")
const codex = nativeHarness("codex")
const opencode = nativeHarness("opencode")
const sessionRef = { projectId: projectId("project-1"), placementId, sessionId: sessionId("s1") }
const row: SessionRow = { ref: sessionRef, title: "Known", createdAt: 1, updatedAt: 1, harness: pi }

function message(id: string, info: Partial<TranscriptMessage>): TranscriptMessage {
  return { id, sessionID: "s1", role: "assistant", ...info }
}

const piTurn = message("m1", { providerID: "pi", modelID: "anthropic/claude-opus-4-8", variant: "high" })

function sessionHydration() {
  const store = createHarnessStore({ getItem: () => null, setItem: () => undefined })
  const options: string[] = []
  const status = createHarnessStatusActions<HarnessScopeInput>({
    applyPatch: store.applyPatch,
    state: store.state,
    fetchConfigOptions: (scope) => void options.push(scope),
    hasConfigOptions: async () => true,
  })
  const hydrator = createHarnessHydrator<HarnessScopeInput>({
    seed: store.seed,
    state: store.state,
    markServer: store.markServer,
    ...status,
    fetchConfigOptions: () => undefined,
    runtime: { placementKind: () => "folder", folderHarness: async () => undefined },
    cache: createScopeCaches().hydrator,
  })
  return { store, hydrator, options }
}

test("known model: the row's saved config comes first, else the last turn run on the session's harness", () => {
  const configured = { ...row, model: { providerId: "pi", modelId: "openai/gpt-5" } }
  expect(knownSessionModel(pi, configured, [piTurn])).toEqual({ providerId: "pi", modelId: "openai/gpt-5" })
  expect(knownSessionModel(pi, row, [piTurn, message("m2", { role: "user" })])).toEqual({ providerId: "pi", modelId: "anthropic/claude-opus-4-8", variant: "high" })
  expect(knownSessionModel(opencode, { ...row, harness: opencode }, [message("m1", { role: "user", model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" } })])).toEqual({
    providerId: "anthropic",
    modelId: "claude-sonnet-4-6",
  })
  expect(knownSessionModel(codex, { ...row, harness: codex }, [piTurn]), "a turn another harness ran").toBeUndefined()
  expect(knownSessionModel(pi, row, [message("m1", { role: "user", model: { providerID: "", modelID: "" } })]), "a streaming prompt's empty model").toBeUndefined()
})

test("session hydration: an existing session runs its row's harness and model, with no read of its own", async () => {
  const { store, hydrator, options } = sessionHydration()
  await hydrator.hydrate("session:s1", { placementId, sessionId: "s1", sessionRef, sessionHarness: pi, sessionModel: () => knownSessionModel(pi, row, [piTurn]) })
  expect(store.harness("session:s1")).toEqual(pi)
  expect(store.selectedModel("session:s1")).toBe("anthropic/claude-opus-4-8")
  expect(store.selectedThoughtLevel("session:s1")).toBe("high")
  expect(store.read("session:s1").readiness).toBe("ready")
  expect(options).toEqual(["session:s1"])
})

test("session hydration: a row that moves to another model is followed, and one this scope already holds is not re-read", async () => {
  const { store, hydrator, options } = sessionHydration()
  let model = { providerId: "pi", modelId: "anthropic/claude-opus-4-8" }
  const params = () => ({ placementId, sessionId: "s1", sessionRef, sessionHarness: pi, sessionModel: () => model })
  await hydrator.hydrate("session:s1", params())
  model = { providerId: "pi", modelId: "openai/gpt-5" }
  await hydrator.hydrate("session:s1", params())
  expect(store.selectedModel("session:s1")).toBe("openai/gpt-5")
  expect(options).toEqual(["session:s1", "session:s1"])

  store.setSelectedModel("session:s1", { providerId: "pi", modelId: "openai/gpt-5-mini" })
  model = { providerId: "pi", modelId: "openai/gpt-5-mini" }
  await hydrator.hydrate("session:s1", params())
  expect(options, "this app's own write coming back").toHaveLength(2)
})

test("session hydration: a row that names no harness keeps the scope connecting", async () => {
  const { store, hydrator, options } = sessionHydration()
  await hydrator.hydrate("session:s1", { placementId, sessionId: "s1", sessionRef })
  expect(store.harness("session:s1")).toBeUndefined()
  expect(store.read("session:s1").readiness).toBe("polling")
  expect(options).toEqual([])
})

test("draft hydration: a new draft with no saved default and no folder harness knows no harness", async () => {
  const { store, hydrator } = sessionHydration()
  await hydrator.hydrate("draft:placement-1", { placementId })
  expect(store.harness("draft:placement-1")).toBeUndefined()
  expect(store.selectedModel("draft:placement-1")).toBe("")
})
