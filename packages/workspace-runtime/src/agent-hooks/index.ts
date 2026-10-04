export {
  setupAgentHooks,
  cleanupAgentHooks,
  isSetupComplete,
  listWrapperAgents,
  type SetupOptions,
} from "./setup"

export { getTerminalEnvVars, getShellArgs, getCommandShellArgs } from "./core/shell"


export {
  CLAXEDO_DIR,
  BIN_DIR,
  HOOKS_DIR,
  SHELL_DIR,
  BASH_DIR,
} from "./core/constants"
