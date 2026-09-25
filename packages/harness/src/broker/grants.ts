import type { PermissionRequest, RequestAnswer } from "../contract/broker"
import type { BrokerPorts } from "./ports"

const stateKey = "brokerGrants"

export function namespacedGrantKey(connectionId: string, grantKey: string): string {
  return JSON.stringify([connectionId, grantKey])
}

export function hasGrant(ports: BrokerPorts, sessionId: string, connectionId: string, request: PermissionRequest): boolean {
  if (!request.grantKey) return false
  const grants = ports.readPermissionState(sessionId)?.[stateKey]
  return Array.isArray(grants) && grants.includes(namespacedGrantKey(connectionId, request.grantKey))
}

export function grantToSave(connectionId: string, request: PermissionRequest, answer: RequestAnswer): string | undefined {
  return request.grantKey && answer.kind === "permission" && answer.decision === "allow_always"
    ? namespacedGrantKey(connectionId, request.grantKey) : undefined
}
