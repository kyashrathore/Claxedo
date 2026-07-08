import { describe, expect, test } from "bun:test"
import path from "node:path"
import { walkProdSources } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")
const canonicalModelKey = "session-client/composer/model-strategy.ts"

describe("canonical model key guard", () => {
  test("keeps ModelKey defined in one production module", () => {
    const offenders = walkProdSources(appRoot).flatMap((file) => {
      if (file.path === canonicalModelKey) return []
      if (!/^\s*(?:export\s+)?type\s+ModelKey\s*=/m.test(file.text)) return []
      return [`${file.path}: import/re-export ModelKey from ${canonicalModelKey}`]
    })

    expect(offenders).toEqual([])
  })

  test("does not reintroduce LocalModelKey aliases", () => {
    const offenders = walkProdSources(appRoot).flatMap((file) => {
      if (!/\bLocalModelKey\b/.test(file.text)) return []
      return [`${file.path}: use canonical ModelKey instead of LocalModelKey`]
    })

    expect(offenders).toEqual([])
  })

  test("keeps model variant helpers beside the canonical ModelKey", () => {
    const helperDefinition = /\b(?:export\s+)?function\s+(?:getConfiguredAgentVariant|resolveModelVariant|cycleModelVariant)\b/
    const offenders = walkProdSources(appRoot).flatMap((file) => {
      if (file.path === canonicalModelKey) return []
      if (file.text.includes("context/model-variant")) {
        return [`${file.path}: import model variant helpers from ${canonicalModelKey}`]
      }
      if (!helperDefinition.test(file.text)) return []
      return [`${file.path}: define model variant helpers in ${canonicalModelKey}`]
    })

    expect(offenders).toEqual([])
  })
})
