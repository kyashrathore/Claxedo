import { walkTestSources, type SourceFile } from "./scanners"

const USES_BUN_FILE = /Bun\.file\(/
const USES_TO_CONTAIN = /\.toContain\(/

/**
 * Test files that read a source file's raw text via `Bun.file(...).text()`
 * and assert `.toContain`/`.not.toContain` against it, instead of invoking
 * exported functions and asserting behavior. This anti-pattern (renaming a
 * variable or reformatting an import silently breaks the test with zero
 * behavior change) belongs centrally in src/architecture/scanners.ts as a
 * named rule with an allowlist/baseline, not scattered per feature file --
 * this scanner is that landing spot for Wave 1/2 to migrate into.
 */
export function sourceTextGrepOffenders(files: SourceFile[]) {
  return files
    .filter((file) => USES_BUN_FILE.test(file.text) && USES_TO_CONTAIN.test(file.text))
    .map((file) => file.path)
    .sort()
}

/** Every test file in the live tree (outside src/architecture/) using the source-text-grep anti-pattern. */
export function liveSourceTextGrepOffenders(appRoot: string) {
  return sourceTextGrepOffenders(walkTestSources(appRoot))
}
