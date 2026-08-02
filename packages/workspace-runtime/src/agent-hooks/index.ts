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
export { getTerminalEnvVars, getShellArgs, getCommandShellArgs } from "./core/shell"

// Wrappers
export { listWrapperAgents } from "./core/wrappers"

// Constants
export {
  CLAXEDO_DIR,
  BIN_DIR,
  HOOKS_DIR,
  SHELL_DIR,
  BASH_DIR,
} from "./core/constants"
