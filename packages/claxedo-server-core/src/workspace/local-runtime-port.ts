import type { Workspace } from "./store/index"

/**
 * How a shared module reaches a LOCAL workspace's embedded runtime.
 *
 * Three call sites used to do this with a dynamic import written as a VARIABLE
 * plus `@vite-ignore`, deliberately, to keep the local deployment out of the
 * Worker bundle. The intent was right and the mechanism was not: such an edge is
 * invisible to the typechecker, to import rewriters, and to every import-graph
 * gate in this repository. One of them survived a package move silently and
 * broke at runtime while the graph looked clean.
 *
 * A port achieves the same separation and is visible. The composition that owns
 * embedded runtimes installs it; a Worker never does, and a call there fails by
 * name instead of resolving a module that was never meant to be there.
 */
export type LocalWorkspaceRuntimePort = {
  /** Dispatch a request into the workspace's embedded runtime. */
  fetch(ws: Workspace, request: Request): Promise<Response>
  /** Push an Agent Extension snapshot to the workspace's embedded runtime. */
  syncAgentExtensions(
    workspaceId: string,
    installs: unknown[],
    options?: { policyOverrides?: unknown[] },
  ): Promise<void>
}

let installed: LocalWorkspaceRuntimePort | undefined

export function configureLocalWorkspaceRuntime(port: LocalWorkspaceRuntimePort | undefined) {
  installed = port
}

export function localWorkspaceRuntimeInstalled() {
  return installed !== undefined
}

export function localWorkspaceRuntime(): LocalWorkspaceRuntimePort {
  if (!installed) {
    throw new Error(
      "no local workspace runtime configured; call configureLocalWorkspaceRuntime from the composition that owns one",
    )
  }
  return installed
}
