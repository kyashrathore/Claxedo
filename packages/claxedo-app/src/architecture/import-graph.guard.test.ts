import { describe, expect, test } from "bun:test"
import path from "node:path"
import { orphanModules, reachableModules } from "./import-graph"
import baseline from "./orphan-baseline.json"

const appRoot = path.resolve(import.meta.dir, "../..")
const liveTypeContracts = [
  "extensions/types.ts",
  "shared/data/session-lifecycle.ts",
  "shared/data/types.ts",
  "shared/query/types.ts",
  "session-client/composer/prompt-input-props.ts",
  "terminal/backend/types.ts",
  "utils/lru-map.ts",
]

describe("import graph orphan guard", () => {
  test("does not introduce new consumer-less production modules", () => {
    const baselineSet = new Set(baseline)
    const liveTypeContractSet = new Set(liveTypeContracts)
    const offenders = orphanModules(appRoot)
      .filter((file) => !baselineSet.has(file))
      .filter((file) => !liveTypeContractSet.has(file))
      .map((file) => `${file}: consumer-less module -- wire it to the live path or delete it`)

    expect(offenders).toEqual([])
  })

  test("keeps orphan baseline pruned as modules are adopted or deleted", () => {
    const liveOrphans = new Set(orphanModules(appRoot))
    const offenders = baseline
      .filter((file) => !liveOrphans.has(file))
      .map((file) => `${file}: no longer orphaned -- remove it from orphan-baseline.json`)

    expect(offenders).toEqual([])
  })

  test("keeps live prompt submit modules reachable despite comment-like text", () => {
    const reachable = reachableModules(appRoot)

    expect(reachable.has("components/prompt-input/build-request-parts.ts")).toBe(true)
    expect(reachable.has("session/submit/index.ts")).toBe(true)
  })

  test("keeps test-support helpers outside the production import graph", () => {
    const testSupport = [
      "claxedo-ui/workbench/tests/dom-helpers.tsx",
      "claxedo-ui/workbench/tests/state-harness.ts",
      "context/terminal-test-helpers.ts",
    ]
    const reachable = reachableModules(appRoot)
    const orphans = new Set(orphanModules(appRoot))

    expect(testSupport.filter((file) => reachable.has(file))).toEqual([])
    expect(testSupport.filter((file) => orphans.has(file))).toEqual([])
  })

  test("does not report live type contracts or config alias targets as orphans", () => {
    const orphans = new Set(orphanModules(appRoot))

    expect(liveTypeContracts.filter((file) => orphans.has(file))).toEqual([])
  })
})
