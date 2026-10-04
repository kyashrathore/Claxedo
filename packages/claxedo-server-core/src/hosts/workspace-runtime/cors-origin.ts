import type { WorkspaceRuntimeCorsOrigin } from "@claxedo/workspace-runtime"
import { allowedOriginPatterns } from "../../platform/http/cors-origins"

/**
 * Which origins a workspace runtime answers.
 *
 * Loopback only: a runtime exposed any other way is reached through the Relay,
 * which does its own authorization, and a permissive CORS policy there would
 * hand a browser page on any origin a working handle to someone's machine.
 *
 * Shared because both the desktop-local embedded runtime and the hosted sandbox
 * launcher apply the same rule — the launcher itself is hosted and stays in
 * `@claxedo/server`.
 */
export const claxedoCorsOrigin: WorkspaceRuntimeCorsOrigin = (origin, exposure) => {
  if (exposure.kind !== "loopback") return undefined
  if (origin.startsWith("http://localhost:")) return origin
  if (origin.startsWith("http://127.0.0.1:")) return origin
  const patterns = allowedOriginPatterns(process.env.CLAXEDO_ALLOWED_ORIGIN_SUFFIXES)
  if (patterns.some((pattern) => pattern.test(origin))) return origin
  return undefined
}
