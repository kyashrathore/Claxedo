import { describe, expect, test } from "bun:test"
import path from "node:path"
import { orphanModules, reachableModules } from "./import-graph"
import orphanBaseline from "./orphan-baseline.json"

/** Module paths, relative to `src`. Annotated because an empty JSON array
 *  otherwise imports as `never[]`. */
const baseline: readonly string[] = orphanBaseline

const appRoot = path.resolve(import.meta.dir, "../..")
const liveTypeContracts = [
  "features/extensions/data/types.ts",
  "features/session/data/session-lifecycle.ts",
  // Doorbell event mirrors. Same shape as
  // `session-lifecycle.ts` above: the feature owns the event type, the shell
  // folds it into the `ClaxedoEvent` union with a type-only import, so the
  // import graph sees no value edge into them.
  "features/documents/data/document-changed-event.ts",
  "features/session/data/backend/types.ts",
  "features/session/data/query/types.ts",
  "features/session/composer/ui/submit-input.ts",
  "features/session/composer/prompt-input-props.ts",
  "features/terminal/core/backend/types.ts",
  "lib/lru-map.ts",
  "platform/runtime/workspace-runtime.ts",
  "platform/runtime/capabilities.ts",
  "platform/runtime/session.ts",
  // Claxedo's HTTP presentation contract is intentionally consumed only as
  // types; no runtime module should be generated from or coupled to a vendor SDK.
  "platform/api/claxedo-api-types.ts",
  // The workspace-startup port: import-free of any implementation, so the
  // import graph sees it as a pure type contract.
  "platform/runtime/workspace-startup-port.ts",
  "platform/query/project-meta.ts",
  "platform/account/account-port.ts",
  // The machine remote-access port. Type-only from its binder, both
  // implementations and the Settings remote-access controller — the port declares what may
  // be asked for, and each product binds one implementation of it.
  "platform/remote-access/machine-remote-access-port.ts",
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
  }, 20_000)

  test("keeps orphan baseline pruned as modules are adopted or deleted", () => {
    const liveOrphans = new Set(orphanModules(appRoot))
    const offenders = baseline
      .filter((file) => !liveOrphans.has(file))
      .map((file) => `${file}: no longer orphaned -- remove it from orphan-baseline.json`)

    expect(offenders).toEqual([])
  }, 20_000)

  test("keeps live prompt submit modules reachable despite comment-like text", () => {
    const reachable = reachableModules(appRoot)

    expect(reachable.has("features/session/composer/ui/build-request-parts.ts")).toBe(true)
    expect(reachable.has("features/session/submit/index.ts")).toBe(true)
  }, 20_000)

  test("keeps test-support helpers outside the production import graph", () => {
    const testSupport = [
      "app/workbench/workbench/tests/dom-helpers.tsx",
      "app/workbench/workbench/tests/state-harness.ts",
      "features/terminal/providers/test-helpers.ts",
      "architecture/test-support/mock-api.ts",
    ]
    const reachable = reachableModules(appRoot)
    const orphans = new Set(orphanModules(appRoot))

    expect(testSupport.filter((file) => reachable.has(file))).toEqual([])
    expect(testSupport.filter((file) => orphans.has(file))).toEqual([])
    // 20s: two full import-graph walks; shared CI runners cleared bun's 5s
    // default by only ~70ms of headroom before timing out.
  }, 20_000)

  test("does not report live type contracts or config alias targets as orphans", () => {
    const orphans = new Set(orphanModules(appRoot))

    expect(liveTypeContracts.filter((file) => orphans.has(file))).toEqual([])
  }, 20_000)
})
