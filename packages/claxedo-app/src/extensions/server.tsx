/**
 * Server Extensions Factory
 *
 * Provides server-level extensions for cloud functionality including:
 * - URL transformation/canonicalization
 */

import type { ServerExtensions } from "@opencode-ai/app-shared"
import type { ClaxedoConfig } from "../index"
import { authFetch } from "../utils/api"

function normalizeUrl(url: string | undefined): string | undefined {
  const txt = url?.trim()
  if (!txt) return
  return txt.replace(/\/+$/, "")
}

/**
 * Create server extensions for Claxedo cloud mode.
 *
 * @param config - Claxedo configuration
 * @returns ServerExtensions object to register with the extension system
 */
export function serverExtensions(config: ClaxedoConfig): ServerExtensions {
  return {
    /**
     * Transform server URL before use.
     *
     * This can be used for:
     * - URL canonicalization (consistent formatting)
     * - Gateway URL rewriting
     * - Protocol upgrades
     *
     * Currently returns the URL unchanged.
     * Add transformation logic here if needed.
     */
    transformUrl: (url: string): string => normalizeUrl(url) ?? url,

    /**
     * Resolve a cloud session to its gateway URL.
     *
     * Called by directory-layout when a real session ID is in the route.
     * The control plane resolves the session's workspace and returns the
     * current attach target for hosted sessions.
     */
    resolveSessionUrl: async (sessionId: string): Promise<string | null> => {
      if (config.cloudAutoSwitch === false) return null
      const base = normalizeUrl(config.claxedoServerUrl) ?? normalizeUrl(config.gatewayUrl)
      if (!base) return null
      const res = await authFetch(`${base}/api/control/sessions/${encodeURIComponent(sessionId)}/gateway`).catch(() => undefined)
      if (!res?.ok) return null
      const body = await res.json().catch(() => ({})) as { gatewayUrl?: unknown; runnerHost?: unknown }
      if (typeof body.gatewayUrl === "string") return normalizeUrl(body.gatewayUrl) ?? null
      if (body.runnerHost === "central") return base
      return null
    },
  }
}
