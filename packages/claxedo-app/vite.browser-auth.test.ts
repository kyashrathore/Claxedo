import { describe, expect, test } from "bun:test"
import { resolveBrowserAuthBuildSelection } from "./vite.browser-auth"

describe("resolveBrowserAuthBuildSelection", () => {
  test("accepts the better-auth adapter", () => {
    expect(resolveBrowserAuthBuildSelection("better-auth")).toEqual({
      adapter: "better-auth",
      module: "./src/platform/auth/better-auth-browser-auth.ts",
      manualChunks: { "vendor-better-auth": ["better-auth/client"] },
    })
  })

  test("throws on an unset value rather than defaulting", () => {
    expect(() => resolveBrowserAuthBuildSelection(undefined)).toThrow(
      "VITE_CLAXEDO_AUTH_ADAPTER must explicitly select better-auth; there is no browser auth fallback",
    )
  })

  test("throws on any other value", () => {
    expect(() => resolveBrowserAuthBuildSelection("unknown-adapter")).toThrow(
      "VITE_CLAXEDO_AUTH_ADAPTER must explicitly select better-auth; there is no browser auth fallback",
    )
    expect(() => resolveBrowserAuthBuildSelection("")).toThrow(
      "VITE_CLAXEDO_AUTH_ADAPTER must explicitly select better-auth; there is no browser auth fallback",
    )
  })
})
