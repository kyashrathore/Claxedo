import {
  electronMachineRemoteAccess,
  hostConnectorBridge,
} from "./electron-machine-remote-access"
import { configureMachineRemoteAccess } from "@/platform/remote-access/machine-remote-access"

/**
 * Bind the desktop to the Host Connector in Electron main.
 *
 * Returns whether a bridge was found, and binds nothing when there is none.
 * There is deliberately no HTTP fallback: the desktop sidecar does not own
 * those routes, so a fallback would turn missing IPC into a misleading 404.
 */
export function configureDesktopMachineRemoteAccess(scope?: unknown): boolean {
  const bridge = scope === undefined ? hostConnectorBridge() : hostConnectorBridge(scope)
  if (!bridge) return false
  configureMachineRemoteAccess(electronMachineRemoteAccess(bridge))
  return true
}
