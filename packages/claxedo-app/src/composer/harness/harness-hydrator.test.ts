/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId as placement, projectId, sessionId, type HarnessState, type SessionConfig } from "@/server"
import { nativeHarness } from "@/lib/harness-selection"
import { createHarnessHydrator } from "./harness-hydrator"
import { createScopeCaches } from "./scope-caches"

const placementId = placement("placement-1")
const claude = nativeHarness("claude")
const codex = nativeHarness("codex")
const sessionRef = { projectId: projectId("project-1"), placementId, sessionId: sessionId("s1") }

function hydrator(runtime: { folder?: () => Promise<HarnessState | undefined>; config?: () => Promise<SessionConfig | undefined> }, saved?: typeof claude) {
  const events: string[] = []
  const hydrator = createHarnessHydrator({
    seed: () => undefined,
    state: () => undefined,
    beginDraftDefault: () => (saved ? { application: { scope: "draft", workspaceKey: "/w", revision: 1 }, saved: { harness: saved } } : undefined),
    markServer: (scope) => void events.push(`server ${scope}`),
    applyStatus: async (scope, data) => void events.push(`status ${scope} ${JSON.stringify(data.type)}`),
    setPollingHydration: (scope, type) => void events.push(`polling ${scope} ${JSON.stringify(type)}`),
    setKnownHydration: (scope, type, model) => void events.push(`known ${scope} ${JSON.stringify(type)} ${model?.modelId ?? "no model"}`),
    setReadyHydration: (scope, type, options) => void events.push(`ready ${scope} ${JSON.stringify(type)}${options === false ? " without options" : ""}`),
    fetchConfigOptions: async (scope) => void events.push(`options ${scope}`),
    runtime: {
      placementKind: () => "folder",
      folderHarness: runtime.folder ?? (async () => undefined),
      sessionConfig: runtime.config ?? (async () => undefined),
    },
    cache: createScopeCaches().hydrator,
  })
  return { hydrator, events }
}

test("hydrator: a draft opens on its saved harness and loads its options once per stamp", async () => {
  const { hydrator: run, events } = hydrator({}, codex)
  await run.hydrate("draft", { placementId })
  await run.hydrate("draft", { placementId })
  expect(events).toEqual([`ready draft ${JSON.stringify(codex)}`, "options draft"])
})

test("hydrator: a draft with nothing saved takes the folder's harness", async () => {
  const { hydrator: run, events } = hydrator({ folder: async () => ({ type: claude }) })
  await run.hydrate("draft", { placementId })
  expect(events).toEqual([`status draft ${JSON.stringify(claude)}`])
})

test("hydrator: a session reads its own config, and an unreadable one keeps the row's harness connecting", async () => {
  const good = hydrator({ config: async () => ({ harness: { type: claude }, model: null }) })
  await good.hydrator.hydrate("session:s1", { placementId, sessionId: "s1", sessionRef })
  expect(good.events).toEqual(["server session:s1", `status session:s1 ${JSON.stringify(claude)}`])
  const failing = hydrator({ config: async () => Promise.reject(new TypeError("fetch failed")) })
  await failing.hydrator.hydrate("session:s1", { placementId, sessionId: "s1", sessionRef, sessionHarness: codex })
  expect(failing.events).toEqual(["server session:s1", `known session:s1 ${JSON.stringify(codex)} no model`, `polling session:s1 ${JSON.stringify(codex)}`])
})

test("hydrator: a cancel retires the read in flight, and a reprobe runs again", async () => {
  let release: (state: HarnessState) => void = () => undefined
  const { hydrator: run, events } = hydrator({ folder: () => new Promise((resolve) => (release = resolve)) })
  const pending = run.hydrate("draft", { placementId })
  run.cancel("draft")
  release({ type: claude })
  await pending
  expect(events).toEqual([])
  const again = hydrator({ folder: async () => ({ type: claude }) })
  await again.hydrator.hydrate("draft", { placementId })
  await again.hydrator.reprobe("draft", { placementId })
  expect(again.events).toEqual([`status draft ${JSON.stringify(claude)}`, `status draft ${JSON.stringify(claude)}`])
})
