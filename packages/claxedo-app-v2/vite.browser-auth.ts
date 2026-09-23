import type { BrowserAuthAdapterId } from "./src/platform/auth/browser-auth"

export type BrowserAuthBuildSelection = {
  adapter: BrowserAuthAdapterId
  module: string
  manualChunks: Record<string, string[]>
}

export function resolveBrowserAuthBuildSelection(value: string | undefined): BrowserAuthBuildSelection {
  if (value === "better-auth") {
    return {
      adapter: "better-auth",
      module: "./src/platform/auth/better-auth-browser-auth.ts",
      manualChunks: { "vendor-better-auth": ["better-auth/client"] },
    }
  }
  throw new Error(
    "VITE_CLAXEDO_AUTH_ADAPTER must explicitly select better-auth; there is no browser auth fallback",
  )
}
