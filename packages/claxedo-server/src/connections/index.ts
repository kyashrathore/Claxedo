/**
 * Connections host composition for claxedo-server: registers the reference
 * integrations, adapts the store ports, and builds the route gates from
 * claxedo's auth idioms. This module makes every decision the
 * @claxedo/connections kit deliberately refuses to make.
 */
import type { Context } from "hono"
import { randomUUID } from "crypto"
import {
  atlassianIntegration,
  createConnectionsService,
  createIntegrationRegistry,
  createIntegrationsRoutes,
  linearIntegration,
  googleIntegration,
  notionIntegration,
  type CodeHostRepository,
  type ConnectionsService,
  type RouteGate,
} from "@claxedo/connections"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "../platform/auth/auth"
import { isLoopbackLocalRequest, stampRequestPeerAddress } from "../routes/local-only-projection"
import type { ControlPlaneCredentials } from "../authority/services"
import { githubIntegrationForEnv } from "./github-oauth"
import { createConnectionStoreAdapter, createCredentialStoreAdapter } from "./store-adapter"
import { CONNECTION_TURN_HEADER, type ConnectionTurnCredentials } from "./turn-credentials"

export const CONNECTIONS_TOKEN_HEADER = "x-claxedo-connections"

export type RepositoryAccessResult =
  | { ok: true; repository: CodeHostRepository; token: string }
  | { ok: false; status: 401 | 402 | 403 | 404 | 409 | 501 | 502 | 503; code: string }

export type ConnectionsHostOptions = {
  credentials: ControlPlaneCredentials
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  env?: Record<string, string | undefined>
  publicUrl?: string
  turnCredentials?: ConnectionTurnCredentials
}

export function createConnectionsHost(options: ConnectionsHostOptions) {
  const env = options.env ?? process.env
  const owners = new WeakMap<Request, string | undefined>()
  const registry = createIntegrationRegistry()
  for (const reference of [notionIntegration(), atlassianIntegration(), githubIntegrationForEnv(env), linearIntegration()]) {
    registry.register(reference.decl, reference.impl)
  }
  const googleClientId = env.CLAXEDO_INTEGRATION_GOOGLE_CLIENT_ID?.trim()
  const googleClientSecret = env.CLAXEDO_INTEGRATION_GOOGLE_CLIENT_SECRET?.trim()
  if (googleClientId && googleClientSecret) {
    const publicUrl = (options.publicUrl ?? env.CLAXEDO_PUBLIC_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "")
    const google = googleIntegration({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      redirectUri: `${publicUrl}/api/claxedo/integrations/callback`,
      scopes: (env.CLAXEDO_INTEGRATION_GOOGLE_SCOPES ?? "https://www.googleapis.com/auth/drive.file")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
    })
    registry.register(google.decl, google.impl)
  }

  const service = createConnectionsService({
    registry,
    credentials: createCredentialStoreAdapter(options.credentials),
    connections: createConnectionStoreAdapter(),
    newId: randomUUID,
  })

  // Every route: control-plane auth, with unsigned-local accepted ONLY from
  // loopback. D9 NOTE: the PRIMARY unsigned-local gate is now the global
  // `unsignedLocalRequestGuard` mounted at the app-composition root
  // (authority/deployment-mode.ts) — it rejects non-loopback unsigned
  // requests before any route handler runs. The loopback check below is
  // retained as defense-in-depth (these routes may be mounted without the
  // parent app), no longer the sole effective gate.
  //
  // Note: GET /callback is NOT behind this gate by design — it arrives via
  // the provider redirect; single-use TTL attempt state guards it (routes.ts).
  const gate: RouteGate = async (c: Context) => {
    try {
      // Self-sufficient stamp (normally done by the app-level middleware):
      // the loopback check must see the socket peer even when these routes
      // are mounted without the parent app.
      stampRequestPeerAddress(c.req.raw, c.env)
      if (isLoopbackLocalRequest(c.req.raw)) {
        owners.set(c.req.raw, undefined)
        return null
      }
      const context = await controlPlaneAuthContext(c.req.raw, {
        ...(options.authConfig ? { config: options.authConfig } : {}),
        ...(options.verifier ? { verifier: options.verifier } : {}),
      })
      if (context.mode === "unsigned-local") {
        return c.json({ code: "connections_loopback_required" }, 403)
      }
      owners.set(c.req.raw, context.user.subject)
      return null
    } catch (err) {
      if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
      throw err
    }
  }

  // Token + auth-failure routes additionally require loopback AND the custom
  // header: the header makes browser reads non-simple/preflighted so the
  // CORS allowlist actually gates them (a page on any http://localhost:*
  // origin would otherwise pass the loopback check).
  const tokenGate: RouteGate = (c: Context) => {
    stampRequestPeerAddress(c.req.raw, c.env)
    if (!isLoopbackLocalRequest(c.req.raw)) return c.json({ code: "connections_loopback_required" }, 403)
    if (c.req.header(CONNECTIONS_TOKEN_HEADER) !== "1") return c.json({ code: "connections_header_required" }, 403)
    return null
  }

  // Token/auth-failure partition keys come from the host-minted turn
  // credential only. Absent, expired, or unknown credentials resolve the
  // owner-absent team partition.
  const resolveTurn = (c: Context) => options.turnCredentials?.resolve(c.req.header(CONNECTION_TURN_HEADER))
  const tokenOwner = (c: Context) => resolveTurn(c)?.subject

  async function repositoryForAuth(
    auth: SignedControlPlaneAuth | undefined,
    id: string,
    fullName: string,
  ): Promise<RepositoryAccessResult> {
    const visible = (await service.list(auth ? { owner: auth.user.subject } : {}))
      .some((connection) => connection.id === id)
    if (!visible) return { ok: false as const, status: 404, code: "connection_not_found" }
    const listed = await service.listRepositories(id)
    if (!listed.ok) return listed
    const repository = listed.repositories.find((item) => item.fullName === fullName)
    if (!repository) return { ok: false as const, status: 404, code: "repository_not_found" }
    if (!repository.permissions.read) return { ok: false as const, status: 403, code: "repository_read_required" }
    const token = await service.getToken(id, "code-host")
    if (!token.ok) return token
    return { ok: true as const, repository, token: token.response.token }
  }

  return {
    service: service as ConnectionsService,
    routes: createIntegrationsRoutes(service, {
      gate,
      tokenGate,
      owner: (c) => owners.get(c.req.raw),
      tokenOwner,
    }),
    repositoryForAuth,
    dispose: () => service.dispose(),
  }
}
