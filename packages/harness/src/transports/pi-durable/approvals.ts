import { PI_PERMISSION_MODES, type SessionConfig } from "@claxedo/agent-runtime-contract"
import type { ToolCall } from "@earendil-works/pi-ai"
import { permissionDecision, permissionRequest, type TurnBroker } from "../../contract"

export type PiAsker = Pick<TurnBroker, "ask">

const ASKED_TOOLS = ["write", "edit", "bash"]

const protocolPermissionMap = {
  allowOnce: "allow_once", allowAlways: "allow_always",
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
    { optionId: "deny", kind: "reject_once", name: "Deny" },
  ],
} as const

export function piPermissionMode(config: { permissionMode?: string }): string {
  const stored = config.permissionMode
  return PI_PERMISSION_MODES.modes.some((mode) => mode.id === stored) ? stored! : PI_PERMISSION_MODES.defaultModeId
}

export function piAsks(config: SessionConfig, toolName: string): boolean {
  return piPermissionMode(config) === "ask"
    && (ASKED_TOOLS.includes(toolName) || toolName.startsWith("mcp__"))
}

export async function piToolApproval(input: { sessionId: string; call: ToolCall; asker: PiAsker; signal: AbortSignal | undefined }) {
  const { call } = input
  const answer = await input.asker.ask(permissionRequest({
    requestId: `pi-tool:${call.id}`, sessionId: input.sessionId, permission: call.name, title: call.name, grantKey: call.name,
    metadata: { input: call.arguments }, harnessPayload: { toolName: call.name, toolCallId: call.id },
    options: protocolPermissionMap.options,
  }), input.signal ? { signal: input.signal } : undefined)
  const decision = permissionDecision(answer)
  if (decision === protocolPermissionMap.allowOnce || decision === protocolPermissionMap.allowAlways) return undefined
  return { block: decision ? "The person denied this tool call" : "The tool call was not approved" }
}
