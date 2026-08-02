import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  CANONICAL_MODEL_KEY_FILE,
  bannedModelKeyAliases,
  duplicateModelKeyDefinitions,
  scatteredModelVariantHelpers,
} from "./model-key"
import { walkProdSources } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")

describe("canonical model key guard", () => {
  test("keeps ModelKey defined in exactly one production module", () => {
    const offenders = duplicateModelKeyDefinitions(walkProdSources(appRoot)).map(
      (file) => `${file}: import/re-export ModelKey from ${CANONICAL_MODEL_KEY_FILE}`,
    )

    expect(offenders).toEqual([])
  })

  test("does not reintroduce retired ModelKey aliases (LocalModelKey, harnessModelForSubmit, harnessSubmitModel, runnerSubmitModel, bare harnessModel field)", () => {
    const offenders = bannedModelKeyAliases(walkProdSources(appRoot)).map(
      (file) => `${file}: use the canonical ModelKey from ${CANONICAL_MODEL_KEY_FILE} instead`,
    )

    expect(offenders).toEqual([])
  })

  test("keeps model-variant helpers defined beside the canonical ModelKey, not scattered", () => {
    const offenders = scatteredModelVariantHelpers(walkProdSources(appRoot)).map(
      (file) => `${file}: define/import model variant helpers from ${CANONICAL_MODEL_KEY_FILE}`,
    )

    expect(offenders).toEqual([])
  })

  test("duplicateModelKeyDefinitions flags a redeclared ModelKey type and spares an import of it", () => {
    expect(
      duplicateModelKeyDefinitions([
        { path: "shell/duplicate.ts", text: `export type ModelKey = "gpt" | "claude"` },
        { path: "shell/importer.ts", text: `import type { ModelKey } from "${CANONICAL_MODEL_KEY_FILE}"` },
        { path: "shell/near-miss.ts", text: `export type ModelKeyish = string` },
        { path: CANONICAL_MODEL_KEY_FILE, text: `export type ModelKey = "gpt" | "claude"` },
      ]),
    ).toEqual(["shell/duplicate.ts"])
  })

  test("bannedModelKeyAliases flags retired identifiers and spares look-alike names", () => {
    expect(
      bannedModelKeyAliases([
        { path: "shell/offender-alias.ts", text: `const key: LocalModelKey = resolve()` },
        { path: "shell/offender-field.ts", text: `const options = { harnessModel: "gpt" }` },
        { path: "shell/near-miss-prefix.ts", text: `const options = { myHarnessModel: "gpt" }` },
        { path: "shell/near-miss-suffix.ts", text: `const options = { harnessModelId: "gpt" }` },
      ]),
    ).toEqual(["shell/offender-alias.ts", "shell/offender-field.ts"])
  })

  test("scatteredModelVariantHelpers flags a scattered helper and spares a differently named function", () => {
    expect(
      scatteredModelVariantHelpers([
        { path: "shell/offender.ts", text: `export function resolveModelVariant(key: string) { return key }` },
        { path: "shell/offender-import.ts", text: `import { pickVariant } from "context/model-variant"` },
        { path: "shell/near-miss.ts", text: `export function computeModelVariant(key: string) { return key }` },
        { path: CANONICAL_MODEL_KEY_FILE, text: `export function resolveModelVariant(key: string) { return key }` },
      ]),
    ).toEqual(["shell/offender-import.ts", "shell/offender.ts"])
  })
})
