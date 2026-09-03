/**
 * GUARDRAIL: the LOCAL build's EMITTED artifact carries no identity provider.
 *
 * The check that was missing. `src/architecture/local-entry-closure.guard.test.ts`
 * proves the local entry's SOURCE closure never reaches the identity provider, and that guard is
 * sound — but a source graph is not a bundle. Chunk configuration in particular
 * puts modules into the artifact without any import edge to walk: the local
 * config derives from the hosted one, so the hosted `manualChunks` entry naming
 * the identity provider would be inherited by a build whose entire purpose is to
 * have no identity provider in it. The source guard was green throughout and
 * could not have said otherwise, because it does not read files that only exist
 * after `vite build`.
 *
 * So this reads them. It scans every emitted `.js` file in `dist-local` for
 * the identity provider's runtime internals, and separately refuses any emitted asset NAMED
 * after a package this product must not contain.
 *
 * The rules live in `src/architecture/local-bundle-identity.ts`, beside the
 * source-graph guard they complete, and are unit-tested there against fixtures.
 * This file is only the part that needs a real build on disk.
 *
 * Build first, then run:
 *   bun run build:local && bun run scripts/check-local-bundle-identity.ts
 * Or one-shot:
 *   bun run check:local-bundle:build
 *
 * Env:
 *   CLAXEDO_LOCAL_DIST_DIR      override the local build dir (default ./dist-local)
 *   CLAXEDO_MARKER_CONTROL_DIR  a build that DOES contain the identity provider.
 *                               When present, every marker must fire against it —
 *                               the control that turns "no hits" into a result
 *                               instead of a hope.
 *
 * Use `bun run build:marker-control` (./dist-marker-control) for that control,
 * NOT the hosted `./dist`, which this comment used to recommend and which is
 * wrong anywhere the auth env is unset — i.e. on every CI runner.
 * `better-auth-browser-auth.ts` reaches the provider only past an early return on disabled
 * auth, so a hosted build without `VITE_AUTH_ENABLED` emits no provider at all
 * and the control fails every marker. That failure is honest — the control is
 * doing its job — but it reads as a broken gate rather than a missing env var,
 * which is how a correct check gets deleted. `build:marker-control` supplies
 * `VITE_AUTH_ENABLED=true` purely to keep the provider in the graph.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  bundleFailures,
  inspectEmittedBundle,
  isScannableAsset,
  verifyMarkersAreDetectable,
  type EmittedFile,
} from "../src/architecture/local-bundle-identity.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, "..")

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

/** Every emitted asset under `dir`, read once, named relative to `dir`. */
function readEmitted(dir: string): EmittedFile[] {
  const files: EmittedFile[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const file = path.join(current, entry)
      if (statSync(file).isDirectory()) {
        walk(file)
        continue
      }
      const name = path.relative(dir, file).split(path.sep).join("/")
      if (!isScannableAsset(name)) continue
      files.push({ name, text: readFileSync(file, "utf8") })
    }
  }
  walk(dir)
  return files
}

function main() {
  const distDir = path.resolve(appRoot, process.env.CLAXEDO_LOCAL_DIST_DIR || "dist-local")

  if (!existsSync(distDir)) {
    fail(
      `[local-bundle-identity] no local build at ${distDir}.\n` +
        `Run the local build first:  bun run build:local`,
    )
  }

  const emitted = readEmitted(distDir)
  const report = inspectEmittedBundle(emitted)

  // The control, when a known-positive build is available. Reported either way:
  // an unverified marker set is a weaker result than a verified one and saying
  // so costs nothing, whereas letting the two look identical is how a scanner
  // that stopped matching anything goes unnoticed.
  const controlDir = process.env.CLAXEDO_MARKER_CONTROL_DIR
  if (controlDir) {
    const resolved = path.resolve(appRoot, controlDir)
    if (!existsSync(resolved)) fail(`[local-bundle-identity] marker control build not found at ${resolved}`)
    const control = verifyMarkersAreDetectable(readEmitted(resolved))
    if (control.undetected.length) {
      fail(
        `[local-bundle-identity] MARKER CONTROL FAILED against ${controlDir}.\n` +
          `These markers fired nowhere in a build that DOES contain the identity provider, so they\n` +
          `cannot detect one in the local build either:\n  ${control.undetected.join("\n  ")}`,
      )
    }
    console.log(
      `[local-bundle-identity] marker control passed: all ${control.checked} markers fire against ${controlDir}`,
    )
  } else {
    console.log(
      "[local-bundle-identity] marker control NOT run (set CLAXEDO_MARKER_CONTROL_DIR to a hosted build to verify the markers themselves)",
    )
  }

  const failures = bundleFailures(report)
  if (failures.length === 0) {
    console.log(
      `[local-bundle-identity] passed — scanned ${report.scannedFiles} emitted file(s) in ` +
        `${path.relative(appRoot, distDir)}; no identity-provider code and no asset named for one.`,
    )
    return
  }

  console.error("\n[local-bundle-identity] BUILD-ARTIFACT CHECK FAILED\n")
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  console.error(
    "\nThe local product has no identity provider to use. Fix the build configuration —\n" +
      "see vite.local.config.ts — rather than adding an exception here.",
  )
  process.exit(1)
}

main()
