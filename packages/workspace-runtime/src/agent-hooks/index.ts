/**
 * Agent Hooks — public API
 */

// Setup & lifecycle
export {
  setupAgentHooks,
  cleanupAgentHooks,
  isSetupComplete,
  type SetupOptions,
} from "./setup"

// Shell
export { getTerminalEnvVars, getShellArgs, getCommandShellArgs } from "./shell"

// Wrappers
export { listWrapperAgents } from "./wrappers"

// MCP per-agent config
export {
  type McpAgentsState,
  loadMcpAgentConfig,
  describeAgentMcp,
  toggleAgentMcp,
  rebuildOpencodeJsonc,
} from "./mcp"

// Constants
export {
  CLAXEDO_DIR,
  BIN_DIR,
  HOOKS_DIR,
  SHELL_DIR,
  BASH_DIR,
  OPENCODE_CONFIG_DIR,
  OPENCODE_PLUGIN_DIR,
  OPENCODE_AGENT_DIR,
} from "./constants"

// Re-exports from mcp-resolver (used by routes)
export {
  MCP_CAPABLE_AGENTS,
  MANAGED_MCP_SERVERS,
  getClaxedoMcpStdioConfig,
  isManagedMcpServer,
  requireClaxedoMcpStdioConfig,
  resolveClaxedoMcpCommand,
} from "../mcp-resolver"
