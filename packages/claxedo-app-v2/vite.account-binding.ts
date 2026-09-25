export type AccountBindingId = "better-auth" | "desktop"

export type AccountBindingBuildSelection = {
  readonly binding: AccountBindingId
  readonly module: string
  readonly manualChunks: Record<string, string[]>
}

export function resolveAccountBindingSelection(value: string | undefined): AccountBindingBuildSelection {
  if (value === "better-auth") {
    return { binding: "better-auth", module: "./src/auth/better-auth-binding.ts", manualChunks: { "vendor-better-auth": ["better-auth/client"] } }
  }
  if (value === "desktop") return { binding: "desktop", module: "./src/auth/electron-binding.ts", manualChunks: {} }
  throw new Error(
    "VITE_CLAXEDO_AUTH_ADAPTER must select better-auth (the browser's own session) or desktop (Electron main's account); there is no fallback",
  )
}
