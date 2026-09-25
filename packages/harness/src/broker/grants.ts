import type { PermissionRequest, RequestAnswer } from "../contract/broker"
import type { BrokerPorts } from "./ports"

const stateKey = "brokerGrants"

export function hasGrant(ports: BrokerPorts, sessionId: string, request: PermissionRequest): boolean {
  if (!request.grantKey) return false
  const grants = ports.readPermissionState(sessionId)?.[stateKey]
  return Array.isArray(grants) && grants.includes(request.grantKey)
}

export async function saveGrant(
  ports: BrokerPorts,
  sessionId: string,
  request: PermissionRequest,
  answer: RequestAnswer,
): Promise<void> {
  if (!request.grantKey || answer.kind !== "permission" || answer.decision !== "allow_always") return
  const state = ports.readPermissionState(sessionId) ?? {}
  const saved = state[stateKey]
  const grants = Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : []
  if (grants.includes(request.grantKey)) return
  await ports.writePermissionState(sessionId, { ...state, [stateKey]: [...grants, request.grantKey] })
}
