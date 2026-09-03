import type { Hono } from "hono"

/**
 * The one seam through which a HOST adds routes to a Workspace Runtime.
 *
 * Workspace Runtime is the local execution core: files, diffs, PTYs, processes,
 * sessions, events, harness dispatch. Hosted product capabilities are not any
 * of those — they are capabilities that happen to want tool-broker route groups
 * mounted inside the runtime that executes their work.
 *
 * The runtime never imports a hosted capability unconditionally and never
 * mounts its routes on every instance, including the desktop-local one that
 * has none and never will. The cost of doing so would not be a couple of
 * unused route handlers. It would be that the hosted capability sits in the
 * runtime's dependency closure, so a desktop build could not be shown to
 * exclude it even after the UI is gone — the lower layer would drag it back in.
 *
 * This contract inverts the direction. The runtime knows only that a host may
 * hand it named route groups with a lifetime; it learns nothing about what they
 * are for. A host-supplied adapter supplies the hosted groups,
 * the hosted launcher passes them, and the desktop-local runtime passes none.
 *
 * Deliberately not a plugin system. There is no discovery, no registry file, no
 * ordering policy, no capability negotiation. A host that wants routes passes
 * them in an array; anything more would be a second composition mechanism
 * competing with the app's contribution registry.
 */

/**
 * What a contribution is allowed to know about the runtime it mounts into.
 *
 * Narrow on purpose. A contribution gets the workspace identity and the
 * session-tool registration seam — enough to broker tools for a session — and
 * no handle on the store, the harness registry, or the process manager.
 */
export type WorkspaceRuntimeRouteContext = {
  /** Canonical ID of the workspace this runtime instance serves. */
  workspaceId: string
  /**
   * Register this contribution's tools for a session under a named group.
   *
   * Grouping matters: several contributions can register tools for the SAME
   * session, and the runtime merges the groups into one registration. Without
   * a group name the last writer would silently replace the others' tools.
   */
  registerSessionTools(group: string): (registration: SessionToolRegistration) => Promise<void>
  /** Drop this contribution's group for a session, keeping other groups intact. */
  unregisterSessionTools(group: string): (sessionId: string) => Promise<void>
}

/**
 * Structurally what `host.registerSessionTools` accepts.
 *
 * Declared here rather than imported so this module stays free of the host
 * surface — the contract has to be safe for a contribution package to depend on
 * without pulling the runtime implementation with it.
 */
export type SessionToolRegistration = {
  sessionId: string
  harness?: string
  callbackUrl: string
  tools: Array<{
    name: string
    description: string
    inputSchema: Record<string, unknown>
    outputSchema?: Record<string, unknown>
  }>
}

/** A mounted contribution: where its routes live and how to tear them down. */
export type WorkspaceRuntimeRouteMount = {
  /** Mount prefix, as passed to `app.route(...)`. Almost always `"/"`. */
  path: string
  routes: Hono
  /**
   * Release everything the mount owns — callback servers, timers, bindings.
   *
   * Called exactly once during runtime shutdown, and required rather than
   * optional: a contribution that opens a callback server and cannot be told to
   * close it turns every runtime teardown into a leaked listener.
   */
  dispose(): void
}

export type WorkspaceRuntimeRouteContribution = {
  /**
   * Stable identifier, unique within one runtime instance.
   *
   * Duplicates are rejected at mount time rather than allowed to shadow each
   * other, because two contributions claiming one ID is a composition bug and
   * silently keeping the second one makes it invisible.
   */
  id: string
  mount(context: WorkspaceRuntimeRouteContext): WorkspaceRuntimeRouteMount
}

export class WorkspaceRuntimeRouteContributionError extends Error {
  constructor(readonly code: "duplicate_contribution_id", message: string) {
    super(message)
    this.name = "WorkspaceRuntimeRouteContributionError"
  }
}

/**
 * Mount every contribution once, returning one disposer for all of them.
 *
 * Disposal is all-or-nothing and best-effort: one contribution throwing must
 * not strand the rest, because this runs on the shutdown path where the
 * alternative is a process that will not exit.
 */
export function mountRouteContributions(input: {
  app: Pick<Hono, "route">
  contributions: readonly WorkspaceRuntimeRouteContribution[]
  context: WorkspaceRuntimeRouteContext
}): { dispose(): void } {
  const seen = new Set<string>()
  const mounts: WorkspaceRuntimeRouteMount[] = []

  for (const contribution of input.contributions) {
    if (seen.has(contribution.id)) {
      throw new WorkspaceRuntimeRouteContributionError(
        "duplicate_contribution_id",
        `Workspace Runtime route contribution "${contribution.id}" is registered twice`,
      )
    }
    seen.add(contribution.id)
    const mount = contribution.mount(input.context)
    input.app.route(mount.path, mount.routes)
    mounts.push(mount)
  }

  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      for (const mount of mounts) {
        try {
          mount.dispose()
        } catch {
          // A contribution that fails to clean up must not block the others.
        }
      }
    },
  }
}
