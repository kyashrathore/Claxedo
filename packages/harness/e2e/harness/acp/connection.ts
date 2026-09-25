import path from "node:path"
import { ACP_FAULT_ENV, ACP_RED_ENV, ACP_SCRIPT_DIR_ENV, ACP_WITHHOLD_ONCE_ENV } from "./script"

export const SCRIPTED_ACP_CONNECTION_ID = "scripted-acp"
export const SCRIPTED_ACP_HARNESS = { id: SCRIPTED_ACP_CONNECTION_ID, access: "connection" } as const
export const SCRIPTED_ACP_WEBSOCKET_CONNECTION_ID = "scripted-acp-websocket"
export const SCRIPTED_ACP_WEBSOCKET_HARNESS = { id: SCRIPTED_ACP_WEBSOCKET_CONNECTION_ID, access: "connection" } as const

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
        env: { [ACP_SCRIPT_DIR_ENV]: input.scriptDir, ...(input.red ? { [ACP_RED_ENV]: "1" } : {}),
          ...(process.env.CLAXEDO_E2E_ACP_WITHHOLD_ONCE_OPTION === "1" ? { [ACP_WITHHOLD_ONCE_ENV]: "1" } : {}),
          ...(process.env.CLAXEDO_E2E_ACP_FAULT ? { [ACP_FAULT_ENV]: process.env.CLAXEDO_E2E_ACP_FAULT } : {}) },
      },
      modelSelection: { status: "optional" },
    },
  }
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
