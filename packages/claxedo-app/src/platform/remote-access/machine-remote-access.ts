import {
  electronMachineRemoteAccess,
  hostConnectorBridge,
} from "./electron-machine-remote-access"
import { httpMachineRemoteAccess, type RemoteAccessRequest } from "./http-machine-remote-access"
import type { MachineRemoteAccessPort } from "./machine-remote-access-port"

/**
 * Who supplies the machine remote-access port for this build.
 *
 * Module-scoped rather than a Solid context, for the same reason
 * `platform/runtime/workspace-startup.ts` is: the binding has to be installed
 * once at boot by a composition root, and the surface that reads it is not the
 * only possible caller.
 *
 * Bound by:
 *
 *   - `app/entry/main.tsx` — the hosted and self-hosted browser entry, which
 *     talks to a server that serves `/api/claxedo/remote-access/*`.
 *   - `claxedo-desktop/src/renderer/index.tsx` — Electron, which reaches the
 *     Host Connector in main by named IPC.
 *
 * `app/entry/local.tsx` binds nothing on purpose: `@claxedo/local-server`
 * serves none of those routes and there is no Electron main under it, so a
 * local browser build genuinely cannot publish a machine.
 *
 * Unlike `workspaceStartup()`, this accessor RETURNS undefined instead of
 * throwing. The difference is not tolerance: "this product cannot publish a
 * machine" is a real product state that the Remote Access surface renders as a
 * locked panel with a reason, whereas waking a cloud sandbox from a local build
 * is a wiring bug with no honest UI. Absence here is answered, not swallowed —
 * `remote-access-controller.ts` has no branch that ignores it.
 */
let boundPort: MachineRemoteAccessPort | undefined

export function configureMachineRemoteAccess(port: MachineRemoteAccessPort) {
  boundPort = port
}

/** Test-only unbind. Production binds once, at boot, and never clears. */
export function resetMachineRemoteAccess() {
  boundPort = undefined
}

/** The bound port, or undefined in a build that cannot publish a machine. */
export function machineRemoteAccess(): MachineRemoteAccessPort | undefined {
  return boundPort
}

/**
 * Bind the product that serves its own `/api/claxedo/remote-access/*` routes.
 *
 * Self-hosted Node, and hosted. `request` is the authenticated transport the
 * entry already owns; this layer decides the path and the verb, which is the
 * whole point of the seam.
 */
export function configureHttpMachineRemoteAccess(request: RemoteAccessRequest) {
  configureMachineRemoteAccess(httpMachineRemoteAccess({ request }))
}

/**
 * Bind the desktop to the Host Connector in Electron main.
 *
 * Returns whether a bridge was found, and binds NOTHING when there is none.
 * There is deliberately no fall back to the HTTP implementation: the desktop's
 * sidecar serves none of those routes, so falling back would post into a 404 —
 * which is precisely the regression this port exists to close, and it would
 * come back looking like resilience.
 */
export function configureDesktopMachineRemoteAccess(scope?: unknown): boolean {
  const bridge = scope === undefined ? hostConnectorBridge() : hostConnectorBridge(scope)
  if (!bridge) return false
  configureMachineRemoteAccess(electronMachineRemoteAccess(bridge))
  return true
}
