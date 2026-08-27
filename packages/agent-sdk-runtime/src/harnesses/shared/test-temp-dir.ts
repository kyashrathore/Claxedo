import fs from "fs"

/**
 * Best-effort removal of a TEST temp directory, for suites that run under
 * `bun test` on Windows.
 *
 * Two Windows realities meet here: a just-closed sqlite file (and a
 * just-killed child's cwd) stays locked briefly after release, and bun's
 * `rmSync` does not honor `maxRetries` the way Node's does — run 358 showed
 * EBUSY surviving a 10×100ms option-based retry that never actually retried.
 * So the retry loop is explicit, and a directory that is STILL locked after
 * the budget is left for the OS temp cleanup rather than failing the test:
 * these are per-test scratch dirs under os.tmpdir(), not product state, and
 * the suite's assertions have already run by the time cleanup executes.
 */
export function removeTestTempDir(root: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
      return
    } catch {
      const wake = Date.now() + 100
      while (Date.now() < wake) {
        // Busy-wait: cleanup hooks here are synchronous and a timer would
        // outlive the test.
      }
    }
  }
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    // Still locked after ~2s: leave it to the OS temp cleanup.
  }
}
