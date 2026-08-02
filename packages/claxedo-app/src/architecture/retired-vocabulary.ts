import { walkProdSources, walkTestSources, type SourceFile } from "./scanners"

/**
 * The one documented backward-compat site allowed to reference the
 * retired "runner"/"runnerHost" vocabulary: it falls back to an old
 * server response field name that some servers in the fleet may
 * still emit. See src/platform/runtime/session-url.ts for the comment.
 */
export const RETIRED_VOCABULARY_COMPAT_SITE = "platform/runtime/session-url.ts"

const PATTERN = /runner/i

/** Files (from a caller-provided list) that reference the retired vocabulary, sorted. */
export function scanForRetiredVocabulary(files: SourceFile[]) {
  return files
    .filter((file) => file.path !== RETIRED_VOCABULARY_COMPAT_SITE)
    .filter((file) => PATTERN.test(file.text))
    .map((file) => file.path)
    .sort()
}

/** Every production or test file in the live tree that references the retired vocabulary. */
export function retiredVocabularyOffenders(appRoot: string) {
  return scanForRetiredVocabulary([...walkProdSources(appRoot), ...walkTestSources(appRoot)])
}
