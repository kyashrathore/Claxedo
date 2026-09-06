import { walkTestSources, type SourceFile } from "./scanners"

const USES_BUN_FILE = /Bun\.file\(/
const USES_TO_CONTAIN = /\.toContain\(/

/**
 * Test files that read a source file's raw text via `Bun.file(...).text()` and
 * assert `.toContain` against it instead of exercising exported behavior. A
 * rename or import reformat breaks such a test with zero behavior change, so
 * source-text rules belong here as named scanners with a baseline, not in
 * per-feature test files.
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
