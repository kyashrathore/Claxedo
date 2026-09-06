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
