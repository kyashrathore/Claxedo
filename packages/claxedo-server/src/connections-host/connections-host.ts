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
  githubIntegration,
  googleIntegration,
  notionIntegration,
  type ConnectionsService,
  type RouteGate,
} from "@claxedo/connections"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "../control-plane/auth"
import { isLoopbackLocalRequest, stampRequestPeerAddress } from "../routes/local-only-projection"
import type { ControlPlaneCredentials } from "../control-plane/services"
import { createConnectionStoreAdapter, createCredentialStoreAdapter } from "./store-adapter"
import { CONNECTION_TURN_HEADER, type ConnectionTurnCredentials } from "./turn-credentials"

export const CONNECTIONS_TOKEN_HEADER = "x-claxedo-connections"

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
  for (const reference of [notionIntegration(), atlassianIntegration(), githubIntegration()]) {
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
  // loopback. Stricter than routes/events.ts: in unsigned mode
  // controlPlaneAuthContext is a pass-through, so the loopback check is the
  // effective gate — never copy the ungated credential/provider-auth mounts.
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

  return {
    service: service as ConnectionsService,
    routes: createIntegrationsRoutes(service, {
      gate,
      tokenGate,
      owner: (c) => owners.get(c.req.raw),
      // Absent, expired, or unknown credentials resolve team-only. The host
      // minted credential is the sole input that unlocks personal rows.
      tokenOwner: (c) => options.turnCredentials?.resolve(c.req.header(CONNECTION_TURN_HEADER))?.subject,
    }),
    dispose: () => service.dispose(),
  }
}
