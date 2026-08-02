import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { importPattern } from "../test-helpers/guards"

// Control-plane central persistence is separate from workspace-runtime and
// agent-sdk-runtime execution persistence. The
// control-plane sync code owns `ProjectionStore` + `DurableSessionLog` and must
// never import or inspect the runtime execution stores. This guard fails if any
// of these files reach for a runtime store symbol (by import or by named token).

// Files that make up the control-plane central-storage seam.
const centralStoreFiles = [
  "http-session-pull.ts",
  "hosted-session-pull.ts",
  "projection-store.ts",
  "durable-session-log.ts",
]

// Runtime execution-store symbols the central seam must not touch. These live in
// `workspace-runtime/src/store.ts` (`RuntimeStore`) and the agent-sdk-runtime
// adapter stores (`AgentRuntimeStore`, `createMemoryRuntimeStore`,
// `createSqliteRuntimeStore`, `@claxedo/agent-sdk-runtime/stores/*`).
const forbiddenSymbols = [
  "RuntimeStore",
  "AgentRuntimeStore",
  "MemoryRuntimeStore",
  "SqliteRuntimeStore",
]

const forbiddenModuleImports = [
  "@claxedo/agent-sdk-runtime",
  "workspace-runtime/src/store",
  "/stores/memory",
  "/stores/sqlite",
]

describe("control-plane central-store boundary", () => {
  test("control-plane sync code does not reference runtime execution store symbols", () => {
    const offenders = centralStoreFiles.flatMap((file) => {
      const text = fs.readFileSync(path.resolve(import.meta.dirname, file), "utf8")
      return forbiddenSymbols.filter((symbol) => text.includes(symbol)).map((symbol) => `${file}:${symbol}`)
    })

    expect(offenders).toEqual([])
  })

  test("control-plane sync code does not import runtime execution store modules", () => {
    const offenders = centralStoreFiles.flatMap((file) => {
      const text = fs.readFileSync(path.resolve(import.meta.dirname, file), "utf8")
      return forbiddenModuleImports
        .filter((module) => importPattern(module).test(text))
        .map((module) => `${file}:${module}`)
    })

    expect(offenders).toEqual([])
  })
})
