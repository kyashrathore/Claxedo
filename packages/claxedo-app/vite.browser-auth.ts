import type { BrowserAuthAdapterId } from "./src/platform/auth/browser-auth"

export type BrowserAuthBuildSelection = {
  adapter: BrowserAuthAdapterId
  module: string
  manualChunks: Record<string, string[]>
}

export function resolveBrowserAuthBuildSelection(value: string | undefined): BrowserAuthBuildSelection {
  if (value === "better-auth") {
    return {
      adapter: value,
      module: "./src/platform/auth/better-auth-browser-auth.ts",
      manualChunks: { "vendor-better-auth": ["better-auth/client"] },
    }
  }
  if (value === "clerk") {
    return {
      adapter: value,
      module: "./src/platform/auth/clerk-browser-auth.ts",
      manualChunks: { "vendor-clerk": ["@clerk/clerk-js/headless"] },
    }
  }
  throw new Error(
    "VITE_CLAXEDO_AUTH_ADAPTER must explicitly select better-auth or clerk; there is no browser auth fallback",
  )
}
