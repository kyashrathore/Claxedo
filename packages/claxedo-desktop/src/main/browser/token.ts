/**
 * Per-launch shared secret and URL for the local desktop HTTP bridge.
 *
 * Minted at main-process boot (the first call to `ensureDesktopToken()`),
 * kept in process memory only, and handed to local agent tool subprocesses via env
 * (`CLAXEDO_DESKTOP_URL` + `CLAXEDO_DESKTOP_TOKEN`). MCP calls must send the
 * token in the `x-claxedo-desktop-token` custom request header — browsers
 * cannot set custom headers cross-origin without a CORS preflight, which the
 * bridge never grants. This is the primary CSRF defense.
 *
 * Nothing here persists across launches; a desktop crash or relaunch rotates
 * the secret automatically and invalidates in-flight MCP requests (MCP must
 * tolerate `401` and re-read env on next call).
 */

import { randomUUID } from "node:crypto"

let cachedToken: string | undefined
let cachedUrl: string | undefined

/**
 * Header name the MCP → bridge round-trip uses for auth. Exported as a
 * constant so the bridge middleware and the MCP `desktopRequest` helper share
 * one source of truth.
 */
export const DESKTOP_TOKEN_HEADER = "x-claxedo-desktop-token"

/**
 * Synthetic `Origin:` value the MCP sends. Anything else is rejected by the
 * bridge CSRF middleware.
 */
export const DESKTOP_MCP_ORIGIN = "claxedo-agent-tools://local"

/** Mint (or return the cached) per-launch secret. */
export function ensureDesktopToken(): string {
  if (!cachedToken) cachedToken = randomUUID()
  return cachedToken
}

/** Return the current token; mints one if none exists yet. */
export function getDesktopToken(): string {
  return ensureDesktopToken()
}

/**
 * Record the URL the bridge listener is bound to. Called by
 * `http-bridge.ts` once the HTTP server has been assigned its ephemeral
 * port. `getDesktopUrl()` readers MUST call this during startup before
 * spawning any subprocess that needs to reach the bridge.
 */
export function setDesktopUrl(url: string): void {
  cachedUrl = url
}

/**
 * Current bridge URL, or `undefined` if the bridge has not started yet.
 * Unlike `getDesktopToken`, this does not fabricate a value — a missing URL
 * is a real "feature disabled" signal we want to surface to MCP consumers.
 */
export function getDesktopUrl(): string | undefined {
  return cachedUrl
}

/** Reset state. Test-only — never call from production code paths. */
export function __resetDesktopAuthForTests(): void {
  cachedToken = undefined
  cachedUrl = undefined
}
