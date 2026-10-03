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

export function piPermissionMode(config: Pick<SessionConfig, "permissionMode" | "permissionCeiling">): string {
  if (config.permissionCeiling !== undefined && config.permissionCeiling !== "full") return "ask"
  return PI_PERMISSION_MODES.modes.find((mode) => mode.id === config.permissionMode)?.id ?? PI_PERMISSION_MODES.defaultModeId
}

export function piAsks(config: SessionConfig, toolName: string): boolean {
  return piPermissionMode(config) === "ask"
    && (ASKED_TOOLS.includes(toolName) || toolName.startsWith("mcp__"))
}

export type PiApprovalInput = { sessionId: string; call: ToolCall; asker: PiAsker; signal: AbortSignal | undefined; opening: string }

function askTool(input: PiApprovalInput, requestId: string) {
  const { call } = input
  return input.asker.ask(permissionRequest({
    requestId, sessionId: input.sessionId, permission: call.name, title: call.name, grantKey: call.name,
    metadata: { input: call.arguments }, harnessPayload: { toolName: call.name, toolCallId: call.id },
    options: protocolPermissionMap.options,
  }), input.signal ? { signal: input.signal } : undefined)
}

export async function piToolApproval(input: PiApprovalInput) {
  const requestId = `pi-tool:${input.call.id}`
  const recorded = await askTool(input, requestId)
  const answer = recorded.kind === "cancelled" && !input.signal?.aborted ? await askTool(input, `${requestId}:${input.opening}`) : recorded
  const decision = permissionDecision(answer)
  if (decision === protocolPermissionMap.allowOnce || decision === protocolPermissionMap.allowAlways) return undefined
  return { block: decision ? "The person denied this tool call" : "The tool call was not approved" }
}
