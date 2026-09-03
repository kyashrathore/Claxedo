import { describe, expect, test } from "bun:test"
import { resolveBrowserAuthBuildSelection } from "../../vite.browser-auth"

describe("browser auth build composition", () => {
  test("maps each explicit adapter to one implementation and one provider chunk policy", () => {
    expect(resolveBrowserAuthBuildSelection("better-auth")).toEqual({
      adapter: "better-auth",
      module: "./src/platform/auth/better-auth-browser-auth.ts",
      manualChunks: { "vendor-better-auth": ["better-auth/client"] },
    })
    expect(resolveBrowserAuthBuildSelection("clerk")).toEqual({
      adapter: "clerk",
      module: "./src/platform/auth/clerk-browser-auth.ts",
      manualChunks: { "vendor-clerk": ["@clerk/clerk-js/headless"] },
    })
  })

  test("refuses an absent or unknown selection instead of choosing a runtime fallback", () => {
    expect(() => resolveBrowserAuthBuildSelection(undefined)).toThrow(/must explicitly select/)
    expect(() => resolveBrowserAuthBuildSelection("custom")).toThrow(/must explicitly select/)
  })
})
