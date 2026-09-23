import {
  createWorkspaceRuntimeCaller,
  without,
  type WorkspaceRuntimeClientOptions,
  type WorkspaceRuntimeRequestOptions,
  type WorkspaceRuntimeResponse,
  type WorkspaceScope,
} from "@claxedo/workspace-runtime/client"
import type { ClaxedoPath, ClaxedoProject, ClaxedoProviderAuthorization } from "@/platform/api/claxedo-api-types"

type Options = WorkspaceRuntimeRequestOptions
type Reply<T> = Promise<WorkspaceRuntimeResponse<T>>

/**
 * The routes this client reaches on claxedo-server: the project inventory, the
 * path and health probes, provider OAuth and worktree creation. All but
 * `/global/health` are answered by claxedo-server alone; the workspace runtime
 * serves a health probe of its own at the same path. They speak the same
 * scoped-URL and error-envelope contract as the runtime routes, so the runtime
 * client's caller sends them.
 */
export type ServerRoutesClient = {
  project: {
    list(input?: WorkspaceScope, options?: Options): Reply<ClaxedoProject[]>
    current(input?: WorkspaceScope, options?: Options): Reply<ClaxedoProject>
    /**
     * The write form of `current`: registers the scoped directory's workspace
     * when it has none, then answers the same project. Reads must use
     * `current` — `ensure` is the only member of this client that may create.
     */
    ensure(input?: WorkspaceScope, options?: Options): Reply<ClaxedoProject>
    update(input: WorkspaceScope & { projectID: string; name?: string; icon?: ClaxedoProject["icon"]; commands?: ClaxedoProject["commands"] }, options?: Options): Reply<ClaxedoProject>
  }
  path: { get(input?: WorkspaceScope, options?: Options): Reply<ClaxedoPath> }
  global: { health(options?: Options): Reply<{ healthy: boolean; version?: string }> }
  provider: {
    oauth: {
      authorize(input: WorkspaceScope & { providerID: string; method?: number; inputs?: Record<string, string> }, options?: Options): Reply<ClaxedoProviderAuthorization>
      callback(input: WorkspaceScope & { providerID: string; method?: number; code?: string }, options?: Options): Reply<boolean>
    }
  }
  worktree: {
    create(input?: WorkspaceScope & { worktreeCreateInput?: { name?: string; baseRef?: string } }, options?: Options): Reply<{ directory: string; name?: string }>
    remove(input?: WorkspaceScope & { worktreeRemoveInput?: { directory?: string } }, options?: Options): Reply<boolean>
  }
}

export function createServerRoutesClient(options: WorkspaceRuntimeClientOptions): ServerRoutesClient {
  const caller = createWorkspaceRuntimeCaller(options)
  return {
    project: {
      list: (input = {}, opts) => caller.call({ operation: "project.list", path: "/project", scope: input, options: opts }),
      current: (input = {}, opts) => caller.call({ operation: "project.current", path: "/project/current", scope: input, options: opts }),
      ensure: (input = {}, opts) => caller.call({ operation: "project.ensure", method: "POST", path: "/project/current", scope: input, options: opts }),
      update: (input, opts) => caller.call({
        operation: "project.update",
        method: "PATCH",
        path: `/project/${encodeURIComponent(input.projectID)}`,
        scope: input,
        body: without(input, ["projectID"]),
        options: opts,
      }),
    },
    path: { get: (input = {}, opts) => caller.call({ operation: "path.get", path: "/path", scope: input, options: opts }) },
    global: { health: (opts) => caller.call({ operation: "global.health", path: "/global/health", options: opts }) },
    provider: {
      oauth: {
        authorize: (input, opts) => caller.call({
          operation: "provider.oauth.authorize",
          method: "POST",
          path: `/provider/${encodeURIComponent(input.providerID)}/oauth/authorize`,
          scope: input,
          body: without(input, ["providerID"]),
          options: opts,
        }),
        callback: (input, opts) => caller.call({
          operation: "provider.oauth.callback",
          method: "POST",
          path: `/provider/${encodeURIComponent(input.providerID)}/oauth/callback`,
          scope: input,
          body: without(input, ["providerID"]),
          options: opts,
        }),
      },
    },
    worktree: {
      create: (input = {}, opts) => caller.call({ operation: "worktree.create", method: "POST", path: "/experimental/worktree", scope: input, body: input.worktreeCreateInput ?? {}, options: opts }),
      remove: (input = {}, opts) => caller.call({ operation: "worktree.remove", method: "DELETE", path: "/experimental/worktree", scope: input, body: input.worktreeRemoveInput ?? {}, options: opts }),
    },
  }
}
