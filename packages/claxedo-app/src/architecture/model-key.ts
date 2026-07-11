import type { SourceFile } from "./scanners"

/** The one production module allowed to define the ModelKey type. */
export const CANONICAL_MODEL_KEY_FILE = "session/composer/model-strategy.ts"

/** Identifier/shape names retired by the ModelKey / harness-submit-model rename; must never reappear. */
const BANNED_ALIAS_PATTERN =
  /\bLocalModelKey\b|\bharnessModelForSubmit\b|\bharnessSubmitModel\b|\brunnerSubmitModel\b|\bharnessModel\s*:/

const MODEL_VARIANT_HELPER_PATTERN =
  /\b(?:export\s+)?function\s+(?:getConfiguredAgentVariant|resolveModelVariant|cycleModelVariant)\b/

/** Files that redeclare `type ModelKey` instead of importing the canonical one. */
export function duplicateModelKeyDefinitions(files: SourceFile[]) {
  return files
    .filter((file) => file.path !== CANONICAL_MODEL_KEY_FILE)
    .filter((file) => /^\s*(?:export\s+)?type\s+ModelKey\s*=/m.test(file.text))
    .map((file) => file.path)
    .sort()
}

/** Files referencing a retired ModelKey-era alias/shape that should have been migrated away. */
export function bannedModelKeyAliases(files: SourceFile[]) {
  return files
    .filter((file) => BANNED_ALIAS_PATTERN.test(file.text))
    .map((file) => file.path)
    .sort()
}

/** Files that define or import model-variant helpers outside the canonical ModelKey module. */
export function scatteredModelVariantHelpers(files: SourceFile[]) {
  return files
    .filter((file) => file.path !== CANONICAL_MODEL_KEY_FILE)
    .filter((file) => file.text.includes("context/model-variant") || MODEL_VARIANT_HELPER_PATTERN.test(file.text))
    .map((file) => file.path)
    .sort()
}
