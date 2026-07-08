import * as path from "path"

export const opencodeConfigDir = (root: string) => path.join(root, "opencode-config")
export const opencodePluginDir = (root: string) => path.join(opencodeConfigDir(root), "plugin")
export const opencodeAgentDir = (root: string) => path.join(opencodeConfigDir(root), "agent")

export const OPENCODE_PLUGIN_MARKER = "// Claxedo opencode plugin v1"
export const OPENCODE_PLUGIN = "claxedo-notify.js"
