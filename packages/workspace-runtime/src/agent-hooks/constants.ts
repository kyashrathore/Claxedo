/**
 * Agent Hooks Constants
 *
 * Public constant surface for agent-hooks.
 */

import * as path from "path"
import { CLAXEDO_DIR } from "./core/constants"

export const OPENCODE_CONFIG_DIR = path.join(CLAXEDO_DIR, "opencode-config")
export const OPENCODE_PLUGIN_DIR = path.join(OPENCODE_CONFIG_DIR, "plugin")
export const OPENCODE_AGENT_DIR = path.join(OPENCODE_CONFIG_DIR, "agent")

export const OPENCODE_PLUGIN_MARKER = "// Claxedo opencode plugin v1"

export const OPENCODE_PLUGIN = "claxedo-notify.js"
export const OPENCODE_JSONC = "opencode.jsonc"
export const DOC_AGENT_MD = "doc.md"
export * from "./core/constants"
