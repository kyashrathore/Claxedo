import type { HostSessionAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { Workspace } from "./store/index"

/**
 * How a shared module reaches a local workspace's embedded runtime.
 *
 * A dynamic import written as a variable plus `@vite-ignore` would keep the
 * local deployment out of the Worker bundle, but that edge is invisible to
 * the typechecker, import rewriters, and every import-graph gate in this
 * repository — a package move can silently break it while the graph looks
 * clean.
 *
 * A port achieves the same separation and is visible. The composition that
 * owns embedded runtimes installs it; a Worker never does, and a call there
 * fails by name instead of resolving a module that was never meant to be
 * there.
 */
export type LocalWorkspaceRuntimePort = {
  /** Dispatch a request into the workspace's embedded runtime. */
  fetch(ws: Workspace, request: Request): Promise<Response>
  /**
   * How this process composed the session access of the embedded runtimes it
   * serves — the `SessionAccessPolicy.sessionAuthority` marker of the very
   * policy they are mounted with.
   *
   * `managed-private` means those runtimes refuse `POST /session` without a
   * control-plane reservation, so a client has to reserve before it creates.
   * The client cannot derive that from its own build flags or from the wire it
   * reaches the server on: the same loopback address serves an unsigned daemon
   * (`local`) and a signed self-hosted server (`managed-private`).
   */
  sessionAuthority(): HostSessionAuthority
}

let installed: LocalWorkspaceRuntimePort | undefined

export function configureLocalWorkspaceRuntime(port: LocalWorkspaceRuntimePort | undefined) {
  installed = port
}

export function localWorkspaceRuntime(): LocalWorkspaceRuntimePort {
  if (!installed) {
    throw new Error(
      "no local workspace runtime configured; call configureLocalWorkspaceRuntime from the composition that owns one",
    )
  }
  return installed
}

/**
 * The declared session authority of this process's embedded runtimes, or
 * `undefined` where no composition installed a port.
 *
 * A read rather than a requirement: a Worker control plane serves no workspace
 * from its own filesystem, so "nobody here runs one" is an answer, not the
 * wiring bug `localWorkspaceRuntime()` throws for.
 */
export function localWorkspaceRuntimeSessionAuthority(): HostSessionAuthority | undefined {
  return installed?.sessionAuthority()
}
