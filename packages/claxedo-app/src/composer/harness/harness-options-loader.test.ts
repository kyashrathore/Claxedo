/// <reference types="bun" />
import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import { ServerError, type HarnessOptions } from "@/server"
import { nativeHarness, type HarnessSelection } from "@/lib/harness-selection"
import { createHarnessOptionsLoader } from "./harness-options-loader"
import type { HarnessOptionsStatePatch } from "./options-state"
import { createScopeCaches } from "./scope-caches"

const codex = nativeHarness("codex")
const answer = (stale: boolean): HarnessOptions => ({ source: "harness", stale, offersOptions: true, serviceTiers: [], models: { choices: [{ id: "gpt", name: "GPT" }], current: "gpt" } })

function harness(answers: Array<HarnessOptions | Error>) {
  const patches: HarnessOptionsStatePatch[] = []
  const loading: boolean[] = []
  let current: HarnessSelection = codex
  let calls = 0
  const loader = createHarnessOptionsLoader({
    fetch: async () => {
      const next = answers[Math.min(calls++, answers.length - 1)]
      if (next instanceof Error) throw next
      return next
    },
    currentHarness: () => current,
    selectedModel: () => undefined,
    seed: () => undefined,
    applyPatch: (_scope, patch) => void patches.push(patch),
    setOptionsLoading: (_scope, value) => void loading.push(value),
    cache: createScopeCaches().options,
  })
  return { loader, patches, loading, calls: () => calls, switchTo: (type: HarnessSelection) => (current = type) }
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

test("options loader: a stale answer settles as stale, and nothing reads it again on a timer", async () => {
  const run = harness([answer(true), answer(false)])
  await run.loader.load("draft:a", codex)
  expect(run.patches.at(-1)).toMatchObject({ optionsLoading: false, optionsStale: false, selectedModel: "gpt" })
  jest.advanceTimersByTime(60_000)
  await Promise.resolve()
  expect(run.calls()).toBe(1)
})

test("options loader: an answer for a harness the user switched away from only releases its loading flag", async () => {
  const run = harness([answer(false)])
  const pending = run.loader.load("draft:a", codex)
  run.switchTo(nativeHarness("claude"))
  expect(await pending).toBeUndefined()
  expect(run.patches).toEqual([])
  expect(run.loading).toEqual([true, false])
})

test("options loader: a failed read names the server's reason, or a plain failure when unreachable", async () => {
  const refused = harness([new ServerError({ class: "auth", message: "Codex is signed out", status: 401 })])
  await refused.loader.load("draft:a", codex)
  expect(refused.patches.at(-1)).toMatchObject({ configError: "Codex is signed out", optionsSource: "empty", optionsLoading: false })
  const asleep = harness([new ServerError({ class: "conflict", code: "workspace_stopped", message: "The cloud workspace ws_cloud is not running" })])
  await asleep.loader.load("draft:a", codex)
  expect(asleep.patches.at(-1)?.configError).toBe("The cloud workspace ws_cloud is not running")
  const offline = harness([new TypeError("fetch failed")])
  await offline.loader.load("draft:a", codex)
  expect(offline.patches.at(-1)?.configError).toBe("Failed to load model options")
})


test("options loader: a pushed catalog supersedes the empty read started before credential delivery", async () => {
  const run = harness([{ source: "harness", stale: false, offersOptions: false, serviceTiers: [] }])
  const pending = run.loader.load("session:pi", codex)
  run.loader.receive("session:pi", answer(false))
  await pending
  expect(run.patches).toHaveLength(1)
  expect(run.patches[0]).toMatchObject({ selectedModel: "gpt", dynamicModels: [{ id: "gpt", name: "GPT" }], configError: undefined })
})
