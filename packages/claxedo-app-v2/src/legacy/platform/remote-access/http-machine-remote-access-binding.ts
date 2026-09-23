import { httpMachineRemoteAccess, type RemoteAccessRequest } from "./http-machine-remote-access"
import { configureMachineRemoteAccess } from "./machine-remote-access"

/** Bind a product that serves its own `/api/claxedo/remote-access/*` routes. */
export function configureHttpMachineRemoteAccess(request: RemoteAccessRequest) {
  configureMachineRemoteAccess(httpMachineRemoteAccess({ request }))
}
