import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import {
  controlPlaneAuthContext,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import type { SandboxFetchOptions } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"

type AuthorizedSandboxFetchOptions = {
  services?: ControlPlaneServicesContract
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
}

/**
 * Bind every control-plane-to-runtime request to one explicit principal.
 * Local loopback composition acts as the control-plane service. Signed remote
 * requests use the authority's canonical actor and current workspace role.
 */
export async function sandboxFetchOptionsForRequest(
  request: Request,
  workspaceId: string,
  options: AuthorizedSandboxFetchOptions,
): Promise<SandboxFetchOptions> {
  const url = new URL(request.url)
  const base: SandboxFetchOptions = {
    ...(options.services?.sandbox.sandboxManager
      ? { sandboxManager: options.services.sandbox.sandboxManager }
      : {}),
    ...(options.services?.relay.provider ? { relayProvider: options.services.relay.provider } : {}),
    ...(options.services?.localExecution.enabled && isLoopbackLocalRequest(request)
      ? { loopbackRelayUrl: `${url.protocol}//127.0.0.1${url.port ? `:${url.port}` : ""}` }
      : {}),
    ...(options.services?.defaultHomeRegion ? { defaultHomeRegion: options.services.defaultHomeRegion } : {}),
  }
  if (options.services?.localExecution.enabled && isLoopbackLocalRequest(request)) {
    return {
      ...base,
      runtimeActor: {
        principalKind: "service",
        actorId: "control-plane",
        actorKind: "agent",
      },
      role: "owner",
    }
  }
  if (!options.authConfig?.enabled) return base
  const auth = await controlPlaneAuthContext(request, {
    config: options.authConfig,
    ...(options.verifier ? { verifier: options.verifier } : {}),
  })
  if (auth.mode !== "signed") return base
  const authority = requireAuthority(options.services)
  const [actor, opened] = await Promise.all([
    resolveRuntimeActor(authority, auth),
    authority.openWorkspace(auth, { workspaceId }),
  ])
  const orgId = opened.workspace?.org_id
  const role = opened.role
  if (
    typeof orgId !== "string"
    || (role !== "viewer" && role !== "editor" && role !== "admin" && role !== "owner")
  ) {
    throw new Error("Workspace runtime authority is unavailable")
  }
  return {
    ...base,
    runtimeActor: {
      principalKind: actor.actorKind === "human" ? "user" : "service",
      ...actor,
    },
    orgId,
    role,
  }
}
