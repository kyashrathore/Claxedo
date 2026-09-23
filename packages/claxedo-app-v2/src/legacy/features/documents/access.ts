import { principalHasSignedAccess, type Principal } from "@/platform/auth/identity-provider"
import { centralTransportForServer } from "@/platform/runtime/transport"

export function documentsAccess(input: { principal: Principal; serverUrl?: string }) {
  return principalHasSignedAccess(input.principal) || centralTransportForServer(input.serverUrl) === "loopback"
}
