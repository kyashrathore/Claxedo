import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { importPattern } from "../test-support/guards"

// Control-plane central persistence is separate from workspace-runtime
// execution persistence. The control-plane sync code owns `ProjectionStore` + `DurableSessionLog` and must
// never import or inspect the runtime execution stores. This guard fails if any
// of these files reach for a runtime store symbol (by import or by named token).

// Files that make up the control-plane central-storage seam.
const centralStoreFiles = [
  "http/session-pull.ts",
  "hosted-session-pull.ts",
  "pulled-session.ts",
  "projection-store.ts",
  "../../../claxedo-server-core/src/platform/auth/durable-session-log.ts",
]

// Runtime execution-store symbols the central seam must not touch: the store in
// `session-core/src/store.ts` (`RuntimeStore`) and the runtime host's name
// for it (`AgentRuntimeStore`).
const forbiddenSymbols = [
  "RuntimeStore",
  "AgentRuntimeStore",
]

const forbiddenModuleImports = [
  "workspace-runtime/src/store",
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
