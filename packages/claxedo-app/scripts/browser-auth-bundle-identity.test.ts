import { describe, expect, test } from "bun:test"

import { browserAuthBundleFailures, type BrowserAuthBundleFile } from "./browser-auth-bundle-identity"

function artifact(): BrowserAuthBundleFile[] {
  return [
    { path: "assets/vendor-better-auth-abc.js", content: "provider dependency" },
    { path: "assets/main-abc.js", content: "claxedo-browser-auth:better-auth" },
  ]
}

describe("browser auth production artifact closure", () => {
  test("accepts a closed better-auth artifact", () => {
    expect(browserAuthBundleFailures("better-auth", artifact())).toEqual([])
  })

  test("rejects a bundle missing the selected implementation marker", () => {
    expect(
      browserAuthBundleFailures("better-auth", [{ path: "assets/vendor-better-auth-abc.js", content: "" }]),
    ).toEqual(["missing selected better-auth implementation marker"])
  })

  test("rejects a bundle with neither the marker nor the vendor chunk", () => {
    expect(browserAuthBundleFailures("better-auth", [{ path: "assets/main-abc.js", content: "" }])).toEqual([
      "missing selected better-auth implementation marker",
      "missing selected vendor-better-auth chunk",
    ])
  })

  test("rejects a bundle missing the selected vendor chunk", () => {
    expect(
      browserAuthBundleFailures("better-auth", [
        { path: "assets/main-abc.js", content: "claxedo-browser-auth:better-auth" },
      ]),
    ).toEqual(["missing selected vendor-better-auth chunk"])
  })

  test("contains the test-only browser auth bypass", () => {
    expect(
      browserAuthBundleFailures("better-auth", [
        ...artifact(),
        { path: "assets/main-abc.js", content: "claxedo-browser-auth:better-auth test-bypass-token" },
      ]),
    ).toEqual(["contains the test-only browser auth bypass"])
  })
})
