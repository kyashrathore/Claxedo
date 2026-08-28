import { describe, expect, test } from "bun:test"

import { browserAuthBundleFailures, type BrowserAuthBundleFile } from "./browser-auth-bundle-identity"

function artifact(selected: "better-auth" | "clerk"): BrowserAuthBundleFile[] {
  return [
    { path: `assets/vendor-${selected}-abc.js`, content: "provider dependency" },
    { path: "assets/main-abc.js", content: `claxedo-browser-auth:${selected}` },
  ]
}

describe("browser auth production artifact closure", () => {
  test.each(["better-auth", "clerk"] as const)("accepts a closed %s artifact", (selected) => {
    expect(browserAuthBundleFailures(selected, artifact(selected))).toEqual([])
  })

  test("rejects an unselected provider, its vendor chunk, or the test bypass", () => {
    expect(
      browserAuthBundleFailures("better-auth", [
        ...artifact("better-auth"),
        { path: "assets/vendor-clerk-def.js", content: "claxedo-browser-auth:clerk test-bypass-token" },
      ]),
    ).toEqual([
      "contains unselected clerk implementation",
      "contains unselected vendor-clerk chunk",
      "contains the test-only browser auth bypass",
    ])
  })
})
