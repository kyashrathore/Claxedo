import { centralTransportForServer } from "@/shell/data/transport/transport"
export {
  workspaceDefaultProviderUrl,
  workspaceProviderAuthUrl,
  workspaceProvidersUrl,
} from "../../utils/workspace-control-routes"

export function shouldUseSandboxDriverMutations(input: { baseUrl?: string }) {
  if (!input.baseUrl) return true
  return centralTransportForServer(input.baseUrl) === "loopback"
}
