/**
 * What the local build actually EMITTED, as opposed to what its source graph says.
 *
 * `local-entry-closure.guard.test.ts` next door walks imports from
 * `app/entry/local.tsx` and proves no module route reaches the identity
 * provider. That is a real property and it is not this one. A bundle is not its
 * source graph: chunk configuration, package re-exports, and plugin transforms
 * all add to the artifact without adding an import edge anyone wrote, so a
 * clean source closure and a bundle containing the identity provider are
 * perfectly compatible states. Only reading the emitted files tells them apart.
 *
 * This module is the reading. It is pure — it takes files that were already
 * read and returns findings — so the rules can be exercised against fixtures
 * instead of only against a 20-second build.
 * `scripts/check-local-bundle-identity.ts` is the caller that supplies a real
 * `dist-local`.
 */

/** One emitted asset: its path relative to the build's outDir, and its bytes as text. */
export type EmittedFile = { name: string; text: string }

/**
 * Strings that appear only when the identity provider's body is in a chunk.
 *
 * The first is the marker the app's OWN adapter emits
 * (`better-auth-browser-auth.ts`'s `implementationMarker`), which is why it is
 * satisfiable by nothing else and needs no guessing at library vocabulary. The
 * rest are Better Auth's own client body. A marker that fires in NEITHER build
 * proves nothing and would quietly pad this list with checks that cannot fail —
 * so the hosted build is the control, and `verifyMarkersAreDetectable` below is
 * how a caller re-runs it.
 *
 * Deliberately NOT the bare word "better-auth": every chunk that imported an
 * inherited `vendor-better-auth` chunk would carry that filename as an import
 * specifier, so a substring that loose reports hits on a bundle holding no
 * provider code at all. Markers must be satisfiable only by the provider's own
 * body, or by a marker this repository emits on purpose.
 */
export const IDENTITY_PROVIDER_MARKERS: readonly string[] = [
  "claxedo-browser-auth:better-auth",
  "createAuthClient",
  "better-auth/client",
]

/**
 * Strings the local artifact must CONTAIN.
 *
 * The positive control, and the reason this gate cannot pass by accident. Every
 * assertion here is an absence, and absence is exactly what an empty directory,
 * a failed build, or a mistyped outDir also produce. Without a required marker
 * this file would report a clean bundle for no bundle at all — the "green
 * check, wrong artifact" shape it exists to end.
 */
export const APP_PRESENCE_MARKERS: readonly string[] = ["claxedo", "workspace"]

/**
 * Package names no emitted asset may be NAMED after.
 *
 * A separate rule from the content scan, catching a separate defect. The local
 * config inherits the hosted config's Rollup options, so a `manualChunks` entry
 * naming the identity provider would be carried into a build that must not
 * contain it. Rollup tree-shakes the library away and still emits a small chunk
 * under that name, so the content scan — correctly — finds nothing. The name is
 * the surviving evidence that the local build is configured around a dependency
 * it must never hold, and it is the part that turns into a real leak the moment
 * the package gains a retained side effect.
 */
export const FORBIDDEN_CHUNK_NAME_FRAGMENTS: readonly string[] = ["better-auth"]

export type BundleReport = {
  scannedFiles: number
  /** A forbidden library's body found inside an emitted file. */
  identityLeaks: Array<{ marker: string; file: string }>
  /** An emitted asset named after a package this product must not contain. */
  forbiddenChunkNames: string[]
  /** Required markers the scan never saw — the bundle is not what was expected. */
  missingAppMarkers: string[]
}

/**
 * Only executable output is scanned.
 *
 * Excluding source maps is the point, and `.js` alone already does it —
 * `index-aaaa.js.map` does not end in `.js`. Written as the one condition it
 * is, because the defensive-looking version (`endsWith(".js") &&
 * !endsWith(".map")`) states a second clause that can never fire: mutating it
 * away changed nothing and no test noticed, which is how a reader learns to
 * trust a condition that is not doing any work.
 *
 * Maps are excluded on purpose rather than by accident of extension. The hosted
 * config builds with `sourcemap: "hidden"`, so every chunk has one, and a map
 * carries `sourcesContent` — the ORIGINAL text of every module, comments
 * included. Several modules in this package name the identity provider while
 * explaining why they avoid it, so a scan that read maps would report leaks for
 * prose. `local-entry-closure.guard.test.ts` was bitten by exactly that,
 * failing on its own doc comment.
 */
export function isScannableAsset(name: string) {
  return name.endsWith(".js")
}

export function inspectEmittedBundle(files: readonly EmittedFile[]): BundleReport {
  const scannable = files.filter((file) => isScannableAsset(file.name))
  const identityLeaks: BundleReport["identityLeaks"] = []

  for (const file of scannable) {
    for (const marker of IDENTITY_PROVIDER_MARKERS) {
      if (file.text.includes(marker)) identityLeaks.push({ marker, file: file.name })
    }
  }

  const forbiddenChunkNames = scannable
    .filter((file) => {
      const base = file.name.split("/").pop() ?? file.name
      return FORBIDDEN_CHUNK_NAME_FRAGMENTS.some((fragment) => base.toLowerCase().includes(fragment))
    })
    .map((file) => file.name)

  const missingAppMarkers = APP_PRESENCE_MARKERS.filter(
    (marker) => !scannable.some((file) => file.text.includes(marker)),
  )

  return { scannedFiles: scannable.length, identityLeaks, forbiddenChunkNames, missingAppMarkers }
}

/**
 * The report as failures, in the order a reader should act on them.
 *
 * `missingAppMarkers` comes FIRST and deliberately reads as a broken
 * measurement rather than a policy violation: if the scan did not see the app,
 * nothing else it reports means anything, and a reader who fixes a phantom leak
 * before noticing the empty directory has wasted the trip.
 */
export function bundleFailures(report: BundleReport): string[] {
  const failures: string[] = []

  if (report.missingAppMarkers.length) {
    failures.push(
      `the scan never saw the app itself (missing: ${report.missingAppMarkers.join(", ")}) across ` +
        `${report.scannedFiles} file(s) — this is a broken measurement, not a clean bundle`,
    )
  }

  for (const leak of report.identityLeaks) {
    failures.push(`identity-provider code in the local artifact: "${leak.marker}" found in ${leak.file}`)
  }

  for (const name of report.forbiddenChunkNames) {
    failures.push(
      `the local build emitted "${name}", an asset named after a package this product must not contain — ` +
        `drop the manual chunk it inherited from the hosted config`,
    )
  }

  return failures
}

/**
 * Which markers a KNOWN-POSITIVE artifact proves are real.
 *
 * Handed the hosted build, every marker should fire; one that does not is a
 * check that can never fail, and counting it as coverage is how a list like
 * this rots into decoration. Separate from `inspectEmittedBundle` because it
 * answers the opposite question — not "is this bundle clean" but "can this
 * scanner tell".
 */
export function verifyMarkersAreDetectable(files: readonly EmittedFile[]) {
  const scannable = files.filter((file) => isScannableAsset(file.name))
  const undetected = IDENTITY_PROVIDER_MARKERS.filter(
    (marker) => !scannable.some((file) => file.text.includes(marker)),
  )
  return { checked: IDENTITY_PROVIDER_MARKERS.length, undetected }
}
