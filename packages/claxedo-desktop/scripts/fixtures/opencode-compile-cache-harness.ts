/**
 * Child harness for the compile-cache boot tests.
 *
 * It performs exactly what `claxedo-server-boot.ts` performs before the product
 * entry is compiled — the REAL `enableShippedCompileCaches` — and then does what
 * the boot stub does next: dynamically import an artifact on the far side of the
 * cache boundary. Bundled by the test with Bun in the same shape the shipped
 * server bundle uses (target node, format esm), and run by the real Electron
 * binary with the real `claxedoServerExecArgv()` flags, because both the V8
 * version and the flag hash are part of the compile cache's identity.
 *
 * Both shipped sets are accepted, because the seeding guard is per-LAUNCH and a
 * harness that could only carry one would never exercise it.
 *
 * The imports are CAUGHT. The server bundle refuses to run without its startup
 * environment, and that refusal happens long after its 9.11 MB has been
 * compiled — which is the only part these tests are about. A harness that let
 * the refusal kill the process would lose the runtime's HIT/MISS verdict, which
 * is the whole measurement.
 */
import { writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"

import { enableShippedCompileCaches } from "../../src/shared/opencode-compile-cache"

const [, , dataDir, shippedDir, enginePath, reportPath, serverShippedDir, serverRootDir, deferredEntry] =
  process.argv as string[]

const optional = (value: string | undefined) => (value && value !== "-" ? value : undefined)

const outcome = enableShippedCompileCaches({
  dataDir,
  sources: [
    optional(shippedDir) ? { shippedDir: shippedDir!, rootDir: dirname(enginePath!) } : undefined,
    optional(serverShippedDir) ? { shippedDir: serverShippedDir!, rootDir: serverRootDir! } : undefined,
  ],
})

const refused: string[] = []
for (const artifact of [optional(deferredEntry), optional(enginePath)]) {
  if (!artifact) continue
  try {
    await import(pathToFileURL(artifact).href)
  } catch (error) {
    refused.push(error instanceof Error ? error.message : String(error))
  }
}
writeFileSync(reportPath!, JSON.stringify({ ...outcome, refused }))
process.exit(0)
