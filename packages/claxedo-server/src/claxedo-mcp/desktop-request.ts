/**
 * Minimal HTTP helper for reaching the claxedo-desktop local bridge.
 *
 * The Electron main process stands up a `node:http` listener bound to
 * `127.0.0.1` on an ephemeral port and mints a per-launch shared secret.
 * Both values are pushed into this MCP subprocess's env at spawn time as
 * `CLAXEDO_DESKTOP_URL` / `CLAXEDO_DESKTOP_TOKEN` (see
 * `workspace-runtime/src/mcp-resolver.ts:getClaxedoMcpStdioConfig`).
 *
 * Usage:
 *
 *   const res = await desktopRequest("/browser/tabs")
 *   if (res.ok) { const data = await res.json() ... }
 *   else { /* res.error is a legible string the agent can render as-is *\/ }
 *
 * The `Origin:` header is fixed to the MCP-synthetic value; the custom
 * `x-claxedo-desktop-token` header carries the secret. Both are CSRF defenses
 * — the bridge rejects any request that doesn't look exactly like "from the
 * MCP".
 */

export const DESKTOP_TOKEN_HEADER = "x-claxedo-desktop-token"
export const DESKTOP_MCP_ORIGIN = "claxedo-mcp://local"

/** Legible message surfaced to the agent when we're not running alongside a desktop app. */
export const DESKTOP_UNAVAILABLE_MESSAGE =
  "Browser tabs require the Claxedo desktop app with CLAXEDO_ENABLE_BROWSER_TAB=1. " +
  "Ask the user to open a browser tab in the desktop client, then retry."

export type DesktopEnv = {
  readonly url: string | undefined
  readonly token: string | undefined
}

export function readDesktopEnv(env: NodeJS.ProcessEnv = process.env): DesktopEnv {
  return {
    url: env.CLAXEDO_DESKTOP_URL,
    token: env.CLAXEDO_DESKTOP_TOKEN,
  }
}

export type DesktopSuccess<T> = { ok: true; status: number; data: T }
export type DesktopFailure = { ok: false; status?: number; error: string }
export type DesktopResponse<T> = DesktopSuccess<T> | DesktopFailure

export type DesktopRequestOptions = RequestInit & {
  /** Override for tests — defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Override for tests — defaults to `fetch`. */
  fetchImpl?: typeof fetch
  /** Request timeout in ms. */
  timeoutMs?: number
}

/**
 * Execute a request against the desktop HTTP bridge.
 *
 * Returns a discriminated result so callers never throw across the
 * MCP/tool-call boundary on network errors.
 */
export async function desktopRequest<T = unknown>(
  path: string,
  options: DesktopRequestOptions = {},
): Promise<DesktopResponse<T>> {
  const { env, fetchImpl = fetch, timeoutMs = 15_000, ...init } = options
  const { url, token } = readDesktopEnv(env)
  if (!url || !token) {
    return { ok: false, error: DESKTOP_UNAVAILABLE_MESSAGE }
  }

  const headers = new Headers(init.headers)
  headers.set(DESKTOP_TOKEN_HEADER, token)
  headers.set("Origin", DESKTOP_MCP_ORIGIN)
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(joinUrl(url, path), {
      ...init,
      headers,
      signal: init.signal ?? controller.signal,
    })
    const text = await res.text()
    const data: unknown = text ? safeJsonParse(text) : null
    if (!res.ok) {
      const message =
        (typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : undefined) ?? `desktop bridge returned HTTP ${res.status}`
      return { ok: false, status: res.status, error: message }
    }
    return { ok: true, status: res.status, data: data as T }
  } catch (err) {
    return {
      ok: false,
      error: String(err instanceof Error ? err.message : err) || "desktop request failed",
    }
  } finally {
    clearTimeout(timer)
  }
}

function joinUrl(base: string, path: string): string {
  if (!path) return base
  if (path.startsWith("http://") || path.startsWith("https://")) return path
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  return normalizedBase + normalizedPath
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
