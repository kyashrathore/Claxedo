import { describe, expect, test } from "bun:test"
import path from "node:path"
import { retiredVocabularyOffenders, scanForRetiredVocabulary } from "./retired-vocabulary"
import baseline from "./retired-vocabulary-baseline.json"

const appRoot = path.resolve(import.meta.dir, "../..")

describe("retired vocabulary guard", () => {
  test("flags runner/runnerHost anywhere except the documented compat site", () => {
    expect(
      scanForRetiredVocabulary([
        { path: "platform/runtime/session-url.ts", text: `input.runnerHost` },
        { path: "app/app-shell.tsx", text: `const runner = pickRunner()` },
        { path: "shell/other.tsx", text: `const harness = pickHarness()` },
      ]),
    ).toEqual(["app/app-shell.tsx"])
  })

  test("does not introduce runner/runnerHost references beyond the current baseline", () => {
    const baselineSet = new Set(baseline)
    const offenders = retiredVocabularyOffenders(appRoot)
      .filter((file) => !baselineSet.has(file))
      .map(
        (file) =>
          `${file}: retired "runner"/"runnerHost" vocabulary -- use "harness"/"harnessHost" (see src/${"platform/runtime/session-url.ts"} for the one documented legacy-compat exception)`,
      )

    expect(offenders).toEqual([])
  })

  test("keeps the retired-vocabulary baseline pruned as files migrate off runner/runnerHost", () => {
    const live = new Set(retiredVocabularyOffenders(appRoot))
    const offenders = baseline
      .filter((file) => !live.has(file))
      .map(
        (file) => `${file}: no longer references retired vocabulary -- remove it from retired-vocabulary-baseline.json`,
      )

    expect(offenders).toEqual([])
  })
})
