import { principalHasSignedAccess, type Principal } from "@/platform/auth/identity-provider"
import { centralTransportForServer } from "@/platform/runtime/transport"

export function documentsFeatureAccess(input: { enabled: boolean; principal: Principal; serverUrl?: string }) {
  if (!input.enabled) return false
  return principalHasSignedAccess(input.principal) || centralTransportForServer(input.serverUrl) === "loopback"
}

export function documentsAccess(input: { principal: Principal; serverUrl?: string }) {
  return documentsFeatureAccess({ ...input, enabled: true })
}
