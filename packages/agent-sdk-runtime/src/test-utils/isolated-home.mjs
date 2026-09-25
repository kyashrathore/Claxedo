import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { removeTestTempDir } from "../harnesses/shared/test-temp-dir"
import { HARNESS_STATE_ENV, isolateHarnessHome } from "./harness-state-env.mjs"

export { HARNESS_STATE_ENV }

/**
 * Preloaded ahead of the test module graph, because modules capture home-derived
 * roots in constants at import time.
 */
const home = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-test-home-"))

isolateHarnessHome(home)

const cleanup = () => removeTestTempDir(home)
// `bun test` 1.3.14 runs no exit listeners; Node's test runner has no `bun:test`.
if (process.versions.bun) (await import("bun:test")).afterAll(cleanup)
else process.on("exit", cleanup)
