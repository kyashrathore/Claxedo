export type AuthSource =
  | { readonly kind: "none" }
  | { readonly kind: "basic"; readonly username: string; readonly password: string }
  | { readonly kind: "bearer"; readonly token: (options?: { readonly fresh?: boolean }) => Promise<string | undefined> }

export type ServerConfig = {
  readonly serverUrl: string
  readonly auth: AuthSource
  readonly cookies?: boolean
  readonly eventSocket?: boolean
  readonly maxReconnectAttempts?: number
}

export function normalizeServerUrl(url: string) {
  return url.trim().replace(/\/+$/, "")
}

export function isLoopbackUrl(url: string) {
  try {
    const { hostname, protocol } = new URL(url)
    if (protocol !== "http:" && protocol !== "https:") return false
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
  } catch {
    return false
  }
}
