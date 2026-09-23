/**
 * Server Extensions Factory
 *
 * Provides server-level extensions for cloud functionality including:
 * - URL transformation/canonicalization
 */

import type { ServerExtensions } from "./types"
import type { ExtensionConfig } from "./types"
import { resolveSessionUrl } from "@/platform/runtime/session-url"
import { normalizeUrl } from "@/platform/api/api"

/**
 * Create server extensions for Claxedo cloud mode.
 *
 * @param config - Claxedo configuration
 * @returns ServerExtensions object to register with the extension system
 */
export function serverExtensions(config: ExtensionConfig): ServerExtensions {
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
    resolveSessionUrl: (sessionId: string): Promise<string | null> => resolveSessionUrl(sessionId, config),
  }
}
