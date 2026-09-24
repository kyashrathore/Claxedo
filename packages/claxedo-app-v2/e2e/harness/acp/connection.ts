import path from "node:path"
import { ACP_RED_ENV, ACP_SCRIPT_DIR_ENV } from "./script"

export const SCRIPTED_ACP_CONNECTION_ID = "scripted-acp"
export const SCRIPTED_ACP_HARNESS = { id: SCRIPTED_ACP_CONNECTION_ID, access: "connection" } as const

const AGENT_ENTRY = path.join(import.meta.dirname, "agent.ts")

export function scriptedAcpConnection(input: { bunPath: string; scriptDir: string; red: boolean }) {
  return {
    connectionId: SCRIPTED_ACP_CONNECTION_ID,
    providerKey: "acp",
    configRevision: 1,
    enabled: true,
    config: {
      label: "Scripted ACP",
      connection: {
        kind: "process",
        command: input.bunPath,
        args: [AGENT_ENTRY],
        env: { [ACP_SCRIPT_DIR_ENV]: input.scriptDir, ...(input.red ? { [ACP_RED_ENV]: "1" } : {}) },
      },
      modelSelection: { status: "optional" },
    },
  }
}
