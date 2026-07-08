/**
 * Agent Runtime Plugins
 *
 * OpenCode plugin generation.
 */

import { loadTemplate } from "../core/utils"
import { OPENCODE_PLUGIN_MARKER } from "./constants"

// ── OpenCode plugin ────────────────────────────────────────────────────────

/**
 * Render the OpenCode plugin with the current notify script path.
 * Delegates notifications to the bash notify script for consistent event mapping.
 */
export function generateOpenCodePlugin(notifyPath: string): string {
  return loadTemplate("opencode-plugin.template.txt", {
    MARKER: OPENCODE_PLUGIN_MARKER,
    NOTIFY_PATH: notifyPath,
  })
}
