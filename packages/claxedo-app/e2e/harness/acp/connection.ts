import path from "node:path"
import { ACP_NO_MODELS_ENV, ACP_RED_ENV, ACP_SCRIPT_DIR_ENV } from "./script"

export const SCRIPTED_ACP_CONNECTION_ID = "scripted-acp"
export const SCRIPTED_ACP_HARNESS = { id: SCRIPTED_ACP_CONNECTION_ID, access: "connection" } as const

export const UNSET_ACP_CONNECTION_ID = "unset-acp"
export const UNSET_ACP_HARNESS = { id: UNSET_ACP_CONNECTION_ID, access: "connection" } as const

const AGENT_ENTRY = path.join(import.meta.dirname, "agent.ts")

function acpConnection(input: { connectionId: string; label: string; bunPath: string; env: Record<string, string>; modelSelection?: { status: "optional" } }) {
  return {
    connectionId: input.connectionId,
    providerKey: "acp",
    configRevision: 1,
    enabled: true,
    config: {
      label: input.label,
      connection: { kind: "process", command: input.bunPath, args: [AGENT_ENTRY], env: input.env },
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    },
  }
}

export function scriptedAcpConnection(input: { bunPath: string; scriptDir: string; red: boolean }) {
  return acpConnection({
    connectionId: SCRIPTED_ACP_CONNECTION_ID,
    label: "Scripted ACP",
    bunPath: input.bunPath,
    env: { [ACP_SCRIPT_DIR_ENV]: input.scriptDir, ...(input.red ? { [ACP_RED_ENV]: "1" } : {}) },
    modelSelection: { status: "optional" },
  })
}

export function unsetAcpConnection(input: { bunPath: string; scriptDir: string }) {
  return acpConnection({
    connectionId: UNSET_ACP_CONNECTION_ID,
    label: "Unset ACP",
    bunPath: input.bunPath,
    env: { [ACP_SCRIPT_DIR_ENV]: input.scriptDir, [ACP_NO_MODELS_ENV]: "1" },
  })
}
