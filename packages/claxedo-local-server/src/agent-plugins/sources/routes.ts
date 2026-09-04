import {
  AgentPluginSourceRoutes,
  CLAXEDO_BUILT_IN_SOURCE,
  type AgentPluginSourceRegistry,
} from "@claxedo/server-core/agent-plugins/sources/routes"
import type { AgentPluginSourceProviderCache } from "@claxedo/server-core/agent-plugins/sources/registry"
import type { AgentPluginSourceFetch } from "@claxedo/server-core/agent-plugins/sources/github-public"

/**
 * Unsigned marketplace-source routes.
 *
 * There is one actor -- the machine -- so the caller resolution is a constant
 * and there is no authority: `authority` in a request body is meaningless here,
 * and the decoder folds it to the machine's own registration rather than
 * pretending an organization exists.
 */
export function LocalAgentPluginSourceRoutes(input: {
  registry: AgentPluginSourceRegistry<void>
  cache: AgentPluginSourceProviderCache
  fetch?: AgentPluginSourceFetch
  now?: () => number
}) {
  return AgentPluginSourceRoutes<void>({
    builtIn: [CLAXEDO_BUILT_IN_SOURCE],
    signed: false,
    registry: input.registry,
    cache: input.cache,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.now ? { now: input.now } : {}),
    authenticate: async () => ({ actor: undefined }),
  })
}
