import { centralTransportForServer } from "@/platform/runtime/transport"
export {
  workspaceDefaultProviderUrl,
  workspaceProviderAuthUrl,
  workspaceProvidersUrl,
} from "@/platform/runtime/agent/workspace-control-routes"

export function shouldUseSandboxDriverMutations(input: { baseUrl?: string }) {
  if (!input.baseUrl) return true
  return centralTransportForServer(input.baseUrl) === "loopback"
}
