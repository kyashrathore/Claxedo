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
import { deploymentMode } from "../control-plane/deployment-mode"
import { hostedCredentialsEnabled } from "../control-plane/worker-credentials"
import { isLoopbackLocalRequest, stampRequestPeerAddress } from "../routes/local-only-projection"
import type { ControlPlaneCredentials } from "../control-plane/services"
import { createConnectionStoreAdapter, createCredentialStoreAdapter } from "./store-adapter"
import { CONNECTION_TURN_HEADER, type ConnectionTurnCredentials } from "./turn-credentials"

export const CONNECTIONS_TOKEN_HEADER = "x-claxedo-connections"

/**
 * D7 (launch plan 2026-07-11-012; tenant-hardening design 015 §2 Decision 1):
 * the hosted owner-key formats. The kit treats owner as an opaque string —
 * THESE two functions are the host's definition of what the strings mean on
 * a hosted deployment:
 * - team rows:     `org:{orgId}`   (the caller's Clerk `org_id` claim)
 * - personal rows: `user:{subject}`
 * Self-host keeps owner-absent as the team partition and the bare subject as
 * the personal key — byte-identical, zero migration for self-host rows.
 */
export const orgTeamOwnerKey = (orgId: string) => `org:${orgId}`
export const subjectPersonalOwnerKey = (subject: string) => `user:${subject}`

export type ConnectionsHostOptions = {
  credentials: ControlPlaneCredentials
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  env?: Record<string, string | undefined>
  publicUrl?: string
  turnCredentials?: ConnectionTurnCredentials
  /**
   * D6/B4 entitlement choke point (launch plan 2026-07-11-012; ADR 014 §5):
   * hosted connections are a paid capability. The hosted composition supplies
   * this from src/billing/entitlement.ts (`createEntitlementGate`, capability
   * "hosted-connections"), keyed by the caller's Clerk org id; it returns a
   * ready-to-serve denial (402 free tier / 503 billing mirror unreadable) or
   * undefined when entitled. Only consulted in hosted mode, after the D7 org
   * resolution — self-host never sees it. The D7 hard gate
   * (CLAXEDO_HOSTED_CREDENTIALS_ENABLED, 503 until flipped) remains the
   * rollout floor beneath this; a hosted composition must wire this gate
   * before flipping that flag.
   */
  requireHostedConnectionsEntitlement?: (
    clerkOrgId: string,
  ) => Promise<{ status: 402 | 503; body: { error: { code: string; message: string } } } | undefined>
}

export function createConnectionsHost(options: ConnectionsHostOptions) {
  const env = options.env ?? process.env
  // Hosted deployments partition every connection by org (D7): the team
  // scope is `org:{orgId}`, the personal scope `user:{subject}`, and the
  // owner-absent partition is REFUSED outright. Self-host is byte-identical
  // to the pre-D7 behavior. `deploymentMode` throws on an invalid value —
  // a typo'd deploy manifest must fail composition, not fall open (D9).
  const hosted = deploymentMode(env) === "hosted"
  // Launch hard gate (plan 012 D7): hosted connections stay 503 until the
  // hosted credential surface is deliberately enabled. Org partitioning is
  // live in this module, so the flag is the remaining rollout switch.
  const hostedEnabled = hostedCredentialsEnabled(env)
  type OwnerKeys = { personal?: string; team?: string }
  const owners = new WeakMap<Request, OwnerKeys>()
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
  // loopback. D9 NOTE: the PRIMARY unsigned-local gate is now the global
  // `unsignedLocalRequestGuard` mounted at the app-composition root
  // (control-plane/deployment-mode.ts) — it rejects non-loopback unsigned
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
      // Hosted hard gate: the WHOLE surface (loopback included) answers 503
      // until the hosted rollout flag is on. `connections_unavailable` is
      // the kit's own closed-enum code for "this host has no surface".
      if (hosted && !hostedEnabled) {
        return c.json({ code: "connections_unavailable" }, 503)
      }
      if (isLoopbackLocalRequest(c.req.raw)) {
        // Self-host: loopback IS the trusted single owner — the owner-absent
        // team partition. Hosted: a loopback caller (internal process, SSRF)
        // gets NO partition keys; with `ownerlessRows: "refuse"` below,
        // nothing is readable or writable from here — token routes authorize
        // via turn credentials instead.
        owners.set(c.req.raw, {})
        return null
      }
      const context = await controlPlaneAuthContext(c.req.raw, {
        ...(options.authConfig ? { config: options.authConfig } : {}),
        ...(options.verifier ? { verifier: options.verifier } : {}),
      })
      if (context.mode === "unsigned-local") {
        return c.json({ code: "connections_loopback_required" }, 403)
      }
      if (hosted) {
        // D7 org resolution: the team partition is the caller's org, carried
        // on the verified token (`org_id` claim -> SignedControlPlaneAuth
        // .user.orgId). A signed principal WITHOUT an org (personal Clerk
        // session, CLI token) has no team partition to manage — fail closed
        // rather than fall back to any shared partition.
        const orgId = context.user.orgId
        if (!orgId) return c.json({ code: "connections_org_required" }, 403)
        // D6/B4: hosted connections are entitlement-gated (composed hook, see
        // ConnectionsHostOptions). Fail-closed by construction inside the
        // gate: free tier → 402, billing mirror unreadable → 503.
        if (options.requireHostedConnectionsEntitlement) {
          const denied = await options.requireHostedConnectionsEntitlement(orgId)
          if (denied) return c.json(denied.body, denied.status)
        }
        owners.set(c.req.raw, {
          personal: subjectPersonalOwnerKey(context.user.subject),
          team: orgTeamOwnerKey(orgId),
        })
      } else {
        // Self-host signed mode: bare subject, exactly as before D7.
        owners.set(c.req.raw, { personal: context.user.subject })
      }
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
  // credential ONLY. Self-host: absent/expired/unknown credentials fail safe
  // to the owner-absent team partition (unchanged). Hosted: the personal key
  // is `user:{subject}` and the team key derives from the turn's org — a
  // turn without an org resolves NOTHING team-scoped, never a shared
  // partition (design 015 §2 Decision 1 ride-along).
  const resolveTurn = (c: Context) => options.turnCredentials?.resolve(c.req.header(CONNECTION_TURN_HEADER))
  const tokenOwner = (c: Context) => {
    const subject = resolveTurn(c)?.subject
    if (subject === undefined) return undefined
    return hosted ? subjectPersonalOwnerKey(subject) : subject
  }
  const tokenTeamOwner = (c: Context) => {
    const orgId = resolveTurn(c)?.orgId
    return orgId ? orgTeamOwnerKey(orgId) : undefined
  }

  return {
    service: service as ConnectionsService,
    routes: createIntegrationsRoutes(service, {
      gate,
      tokenGate,
      owner: (c) => owners.get(c.req.raw)?.personal,
      tokenOwner,
      ...(hosted
        ? {
            teamOwner: (c: Context) => owners.get(c.req.raw)?.team,
            tokenTeamOwner,
            // The hosted invariant: the owner-absent partition does not
            // exist — refuse it on every read and write surface.
            ownerlessRows: "refuse" as const,
          }
        : {}),
    }),
    dispose: () => service.dispose(),
  }
}
