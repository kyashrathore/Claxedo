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
 * Product-specific composition roots bind this registry through separate
 * binding modules. Keeping those implementations out of this base-safe module
 * is what lets the unsigned desktop renderer read the port without shipping
 * or loading the optional Electron Host Connector adapter.
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
