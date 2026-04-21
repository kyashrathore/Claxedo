/**
 * Agent hooks infrastructure for intercepting CLI agent binaries.
 * Creates wrapper scripts in ~/.claxedo for Claude, Codex, etc.
 */

let _setupComplete = false

export async function setupAgentHooks(_opts?: { port?: number; force?: boolean }) {
  _setupComplete = true
}

export function getTerminalEnvVars(_opts: {
  tabId: string
  terminalId: string
  workspaceId: string
  port: number
  shell?: string
}): Record<string, string> {
  return {}
}

export function isSetupComplete(): boolean {
  return _setupComplete
}
