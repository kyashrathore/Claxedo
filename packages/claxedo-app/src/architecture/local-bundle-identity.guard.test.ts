import { describe, expect, test } from "bun:test"
import {
  APP_PRESENCE_MARKERS,
  bundleFailures,
  IDENTITY_PROVIDER_MARKERS,
  inspectEmittedBundle,
  isScannableAsset,
  verifyMarkersAreDetectable,
  type EmittedFile,
} from "./local-bundle-identity"

/**
 * The emitted-artifact rules, exercised against fixtures.
 *
 * Fixtures rather than a real `dist-local`, because the real build takes ~20
 * seconds and — more to the point — a passing build cannot demonstrate that
 * these rules would CATCH anything. Every case below is a bundle shaped like a
 * failure, so each rule is shown biting at least once. The real artifact is
 * scanned by `scripts/check-local-bundle-identity.ts`.
 */

/** A minimal bundle that should pass: app present, no identity provider. */
function cleanBundle(): EmittedFile[] {
  return [
    { name: "assets/index.local-aaaa.js", text: 'const a="claxedo";export{a};' },
    { name: "assets/app-shell-bbbb.js", text: 'const w="workspace panel";export{w};' },
  ]
}

describe("what gets scanned", () => {
  test("source maps are not part of the artifact", () => {
    // Maps carry `sourcesContent` — the ORIGINAL text of every module, comments
    // included. Scanning them would report a leak for any file that merely
    // discusses the identity provider, and this package has several that do.
    expect(isScannableAsset("assets/index-aaaa.js")).toBe(true)
    expect(isScannableAsset("assets/index-aaaa.js.map")).toBe(false)
    expect(isScannableAsset("index.local.html")).toBe(false)
  })

  test("a map holding the library's body is ignored, the chunk beside it is not", () => {
    const withMap = inspectEmittedBundle([
      ...cleanBundle(),
      { name: "assets/index-aaaa.js.map", text: '{"sourcesContent":["import ClerkJS from \'@clerk/clerk-js\'"]}' },
    ])
    expect(withMap.identityLeaks).toEqual([])

    const withChunk = inspectEmittedBundle([
      ...cleanBundle(),
      { name: "assets/index-aaaa.js", text: "const c=new ClerkJS()" },
    ])
    expect(withChunk.identityLeaks).toEqual([{ marker: "ClerkJS", file: "assets/index-aaaa.js" }])
  })
})

describe("identity-provider content", () => {
  test("every marker is one the scan actually reports", () => {
    // Not a restatement of the list: it builds a file per marker and requires
    // the scanner to name each one. A marker added to the array but never
    // matched — a typo, a stale spelling — fails here rather than sitting in
    // the list looking like coverage.
    for (const marker of IDENTITY_PROVIDER_MARKERS) {
      const report = inspectEmittedBundle([
        ...cleanBundle(),
        { name: "assets/leak-cccc.js", text: `const x=${JSON.stringify(marker)};` },
      ])

      expect(report.identityLeaks, `marker ${marker} was not detected`).toEqual([
        { marker, file: "assets/leak-cccc.js" },
      ])
      expect(bundleFailures(report).join("\n")).toContain(marker)
    }
  })

  test("a clean bundle reports nothing", () => {
    expect(bundleFailures(inspectEmittedBundle(cleanBundle()))).toEqual([])
  })

  test("no marker is satisfied by an asset FILENAME appearing in another chunk", () => {
    // The measured false positive. When the local build inherited the hosted
    // `vendor-clerk` manual chunk, Rollup emitted a 116-byte chunk under that
    // name holding one CommonJS interop helper and zero Clerk code — and 61
    // other chunks imported it, carrying the string "vendor-clerk-CqkleIqs.js"
    // in their import specifiers. A looser marker set (the bare word "clerk")
    // reports 61 leaks on a bundle containing none.
    const report = inspectEmittedBundle([
      ...cleanBundle(),
      { name: "assets/mermaid-dddd.js", text: 'import"./vendor-clerk-CqkleIqs.js";' },
      { name: "assets/vendor-clerk-CqkleIqs.js", text: "function e(t){return t}export{e as g};" },
    ])

    expect(report.identityLeaks).toEqual([])
  })
})

describe("assets named for a forbidden package", () => {
  test("are refused even when they contain none of its code", () => {
    // The defect the content scan cannot see, and the one that was actually
    // there: an empty chunk still called `vendor-clerk`.
    const report = inspectEmittedBundle([
      ...cleanBundle(),
      { name: "assets/vendor-clerk-CqkleIqs.js", text: "function e(t){return t}export{e as g};" },
    ])

    expect(report.identityLeaks).toEqual([])
    expect(report.forbiddenChunkNames).toEqual(["assets/vendor-clerk-CqkleIqs.js"])
    expect(bundleFailures(report).join("\n")).toContain("vendor-clerk")
  })

  test("a bundle with no such asset reports none", () => {
    expect(inspectEmittedBundle(cleanBundle()).forbiddenChunkNames).toEqual([])
  })
})

describe("the positive control", () => {
  test("an empty directory fails instead of reading as a clean bundle", () => {
    // The whole reason a required-marker list exists. Every other rule here
    // asserts an ABSENCE, and an absent bundle satisfies all of them.
    const report = inspectEmittedBundle([])

    expect(report.scannedFiles).toBe(0)
    expect(report.identityLeaks).toEqual([])
    expect(report.missingAppMarkers).toEqual([...APP_PRESENCE_MARKERS])
    expect(bundleFailures(report)[0]).toContain("broken measurement")
  })

  test("a build missing one required marker still fails", () => {
    const report = inspectEmittedBundle([{ name: "assets/index-aaaa.js", text: 'const a="claxedo";' }])

    expect(report.missingAppMarkers).toEqual(["workspace"])
    expect(bundleFailures(report)).not.toEqual([])
  })
})

describe("marker detectability", () => {
  test("names the markers a known-positive build failed to trigger", () => {
    // Handed a bundle that contains ONE marker, the control must report the
    // rest as undetected — that is how a marker list that has stopped matching
    // the library gets found, instead of quietly passing forever.
    const control = verifyMarkersAreDetectable([{ name: "assets/vendor-eeee.js", text: "clerk.com" }])

    expect(control.checked).toBe(IDENTITY_PROVIDER_MARKERS.length)
    expect(control.undetected).toEqual(IDENTITY_PROVIDER_MARKERS.filter((m) => m !== "clerk.com"))
  })

  test("reports nothing undetected when every marker is present", () => {
    const control = verifyMarkersAreDetectable([
      { name: "assets/vendor-eeee.js", text: IDENTITY_PROVIDER_MARKERS.join(" ") },
    ])

    expect(control.undetected).toEqual([])
  })
})
