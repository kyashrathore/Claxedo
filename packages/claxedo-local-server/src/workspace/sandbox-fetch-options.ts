import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import {
  bearerToken,
  controlPlaneAuthContext,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
} from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import type { SandboxFetchOptions } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"

type AuthorizedSandboxFetchOptions = {
  services?: ControlPlaneServicesContract
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
}

/**
 * Bind every control-plane-to-runtime request to one explicit principal. A
 * request that carries a verified signed identity acts as that caller, with
 * its current workspace role, on loopback too: a private session reads only
 * for its workspace owner or session share holders, and a user-principal token is recorded only under
 * the caller's own auth. An unsigned loopback request acts as the
 * control-plane service.
 */
export async function sandboxFetchOptionsForRequest(
  request: Request,
  workspaceId: string,
  options: AuthorizedSandboxFetchOptions,
): Promise<SandboxFetchOptions> {
  const url = new URL(request.url)
  const loopback = !!options.services?.localExecution.enabled && isLoopbackLocalRequest(request)
  const base: SandboxFetchOptions = {
    ...(options.services?.sandbox.sandboxManager
      ? { sandboxManager: options.services.sandbox.sandboxManager }
      : {}),
    ...(options.services?.relay.provider ? { relayProvider: options.services.relay.provider } : {}),
    ...(loopback
      ? { loopbackRelayUrl: `${url.protocol}//127.0.0.1${url.port ? `:${url.port}` : ""}` }
      : {}),
    ...(options.services?.defaultHomeRegion ? { defaultHomeRegion: options.services.defaultHomeRegion } : {}),
  }
  const auth = options.authConfig?.enabled && (!loopback || bearerToken(request.headers.get("authorization")))
    ? await controlPlaneAuthContext(request, {
        config: options.authConfig,
        ...(options.verifier ? { verifier: options.verifier } : {}),
      })
    : undefined
  if (auth?.mode !== "signed") {
    if (!loopback) return base
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
    auth,
    orgId,
    role,
  }
}
