import path from "node:path"
import { ACP_CORE_ENV, ACP_FAULT_ENV, ACP_NO_MODELS_ENV, ACP_RED_ENV, ACP_SCRIPT_DIR_ENV, ACP_WITHHOLD_ONCE_ENV } from "./script"

export const SCRIPTED_ACP_CONNECTION_ID = "scripted-acp"
export const SCRIPTED_ACP_HARNESS = { id: SCRIPTED_ACP_CONNECTION_ID, access: "connection" } as const
export const SCRIPTED_ACP_WEBSOCKET_CONNECTION_ID = "scripted-acp-websocket"
export const SCRIPTED_ACP_WEBSOCKET_HARNESS = { id: SCRIPTED_ACP_WEBSOCKET_CONNECTION_ID, access: "connection" } as const
export const UNSET_ACP_CONNECTION_ID = "unset-acp"
export const UNSET_ACP_HARNESS = { id: UNSET_ACP_CONNECTION_ID, access: "connection" } as const

export const SCRIPTED_ACP_AGENT_ENTRY = path.join(import.meta.dirname, "agent.ts")

function acpProcessConnection(input: { connectionId: string; label: string; bunPath: string; env: Record<string, string>; modelSelection?: { status: "optional" } }) {
  return {
    connectionId: input.connectionId,
    providerKey: "acp",
    configRevision: 1,
    enabled: true,
    config: {
      label: input.label,
      connection: { kind: "process", command: input.bunPath, args: [SCRIPTED_ACP_AGENT_ENTRY], env: input.env },
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    },
  }
}

export function scriptedAcpConnection(input: { bunPath: string; scriptDir: string; red: boolean; core?: boolean; resistantChild?: boolean }) {
  return acpProcessConnection({
    connectionId: SCRIPTED_ACP_CONNECTION_ID,
    label: "Scripted ACP",
    bunPath: input.bunPath,
    env: { [ACP_SCRIPT_DIR_ENV]: input.scriptDir, ...(input.red ? { [ACP_RED_ENV]: "1" } : {}),
      ...(input.core ? { [ACP_CORE_ENV]: "1" } : {}),
      ...(input.resistantChild ? { SCRIPTED_ACP_RESISTANT_CHILD: "1" } : {}),
      ...(process.env.CLAXEDO_E2E_ACP_WITHHOLD_ONCE_OPTION === "1" ? { [ACP_WITHHOLD_ONCE_ENV]: "1" } : {}),
      ...(process.env.CLAXEDO_E2E_ACP_FAULT ? { [ACP_FAULT_ENV]: process.env.CLAXEDO_E2E_ACP_FAULT } : {}) },
    modelSelection: { status: "optional" },
  })
}

/** A core ACP agent that advertises a model selector with no models and asks for no model selection. */
export function unsetAcpConnection(input: { bunPath: string; scriptDir: string }) {
  return acpProcessConnection({
    connectionId: UNSET_ACP_CONNECTION_ID,
    label: "Unset ACP",
    bunPath: input.bunPath,
    env: { [ACP_SCRIPT_DIR_ENV]: input.scriptDir, [ACP_CORE_ENV]: "1", [ACP_NO_MODELS_ENV]: "1" },
  })
}

export function scriptedAcpWebSocketConnection(url: string, headers: Record<string, string> = {}, connectionId = SCRIPTED_ACP_WEBSOCKET_CONNECTION_ID) {
  return {
    connectionId,
    providerKey: "acp",
    configRevision: 1,
    enabled: true,
    config: {
      label: "Scripted ACP websocket",
      connection: { kind: "websocket", url, headers },
      modelSelection: { status: "optional" },
    },
  }
}
