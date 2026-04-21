/**
 * Server Extensions Factory
 *
 * Provides server-level extensions for cloud functionality including:
 * - URL transformation/canonicalization
 */

import type { ServerExtensions } from "@opencode-ai/app-shared"
import type { ClaxedoConfig } from "../index"

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
    transformUrl: (url: string): string => {
      // Canonicalize: remove trailing slashes for consistency
      return url.replace(/\/+$/, "")
    },

    /**
     * Resolve a cloud session to its gateway URL.
     *
     * Called by directory-layout when the current server URL is localhost
     * and a real session ID is in the route. The claxedo-server proxy
     * (workspaceRuntimeProxy in proxy.ts) already transparently routes
     * cloud workspace requests to the remote runtime based on the
     * directory query param, so no URL switch is needed.
     *
     * Returns null — the current server handles cloud routing.
     * A real implementation would be needed if the frontend must bypass
     * the claxedo-server and connect directly to a different gateway.
     */
    resolveSessionUrl: async (_sessionId: string): Promise<string | null> => {
      return null
    },
  }
}
