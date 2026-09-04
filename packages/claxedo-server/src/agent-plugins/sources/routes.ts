import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import {
  AgentPluginSourceRoutes,
  CLAXEDO_BUILT_IN_SOURCE,
  type AgentPluginSourceRegistry,
} from "@claxedo/server-core/agent-plugins/sources/routes"
import type { AgentPluginSourceProviderCache } from "@claxedo/server-core/agent-plugins/sources/registry"
import type { AgentPluginSourceFetch } from "@claxedo/server-core/agent-plugins/sources/github-public"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../../authority/services"
import { signedOrError } from "../../workspace/route-support"

/**
 * Signed marketplace-source routes.
 *
 * Authentication is the same seam the catalog routes use (`signedOrError` with
 * the deployment's request adapter): a Better Auth + D1 plane composes no token
 * verifier, so a route that only knew `services.auth.verifier` would answer
 * every signed caller with `auth_verifier_unavailable`. Authorization is not
 * here at all — the store resolves the organization and the admin role from the
 * authority, exactly as organization defaults do.
 */
export function HostedAgentPluginSourceRoutes(input: {
  services: ControlPlaneServices
  authentication?: RequestAuthenticationAdapter
  registry: AgentPluginSourceRegistry<SignedControlPlaneAuth>
  cache: AgentPluginSourceProviderCache
  fetch?: AgentPluginSourceFetch
  now?: () => number
}) {
  return AgentPluginSourceRoutes<SignedControlPlaneAuth>({
    builtIn: [CLAXEDO_BUILT_IN_SOURCE],
    signed: true,
    registry: input.registry,
    cache: input.cache,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.now ? { now: input.now } : {}),
    authenticate: async (request) => {
      const result = await signedOrError(request, {
        ...(input.authentication ? { authentication: input.authentication } : {}),
        authConfig: input.services.auth.config,
        ...(input.services.auth.verifier ? { verifier: input.services.auth.verifier } : {}),
        requireSigned: true,
      }, input.services)
      if (!result.auth) {
        if (result.error) return { error: result.error, status: result.status ?? 401 }
        throw new ControlPlaneAuthError(401, "missing_bearer_token", "Signed auth is required")
      }
      if (!input.services.authority) {
        throw new ControlPlaneAuthError(
          503,
          "workspace_authority_unavailable",
          "Agent Plugins requires the workspace authority",
        )
      }
      return { actor: result.auth }
    },
    errors: (cause) => cause instanceof ControlPlaneAuthError
      ? { body: controlPlaneAuthErrorBody(cause), status: cause.status }
      : undefined,
  })
}
