import { createRemoteJWKSet, importSPKI } from "jose"
import { trimToUndefined } from "@claxedo/helpers/string"
import { verifyHostTunnelToken, verifyRuntimeAccessToken, type RelayKey } from "./auth"
import { bearerToken, hostIdFromTunnelPath, workspaceIdsFromSearch } from "./http"
import type { WorkspaceRelayDurableObjectEnv } from "./cloudflare"
import { relayRoomPlacement, type RelayPlacementCredential } from "./relay-location"

/**
 * Runtime access key material for placement-hint authentication, resolved
 * lazily from the same env contract `worker.ts` reads
 * (`CLAXEDO_CONTROL_PLANE_JWKS_URL`, then
 * `CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM`). The gateway is constructed
 * before env exists, so resolution happens per fetch and is cached by the env
 * value itself — both are fixed for a deployment's life, and a JWKS resolver
 * additionally caches its fetched key set.
 */
const placementAuthKeys = new Map<string, Promise<RelayKey | undefined>>()

function placementAuthKey(env: WorkspaceRelayDurableObjectEnv) {
  const jwksUrl = typeof env.CLAXEDO_CONTROL_PLANE_JWKS_URL === "string"
    ? trimToUndefined(env.CLAXEDO_CONTROL_PLANE_JWKS_URL)
    : undefined
  const pem = (typeof env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM === "string"
    ? trimToUndefined(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)
    : undefined)?.replaceAll("\\n", "\n")
  const id = jwksUrl ? `jwks:${jwksUrl}` : pem ? `pem:${pem}` : undefined
  if (!id) return undefined
  const cached = placementAuthKeys.get(id)
  if (cached) return cached
  if (placementAuthKeys.size >= 32) placementAuthKeys.clear()
  const loaded = (async (): Promise<RelayKey | undefined> => {
    try {
      if (jwksUrl) return createRemoteJWKSet(new URL(jwksUrl))
      if (!pem) return undefined
      return await importSPKI(pem, "EdDSA")
    } catch {
      return undefined
    }
  })()
  placementAuthKeys.set(id, loaded)
  return loaded
}

function runtimeAccessTokenFrom(request: Request) {
  return bearerToken(request.headers.get("authorization") ?? undefined)
    ?? request.headers.get("sec-websocket-protocol")
      ?.split(",")
      .map((item) => item.trim())
      .find((item) => item.startsWith("claxedo-rat."))
      ?.slice("claxedo-rat.".length)
}

/**
 * What the request's own credential proves once it verifies against the
 * deployment's runtime access key: the host it reaches. That verdict is the
 * only thing that makes the request's declared placement inputs (region
 * header/param, edge country) trustworthy, and the host id is the only signed
 * statement of whether the workspace's sessions run on their own Durable
 * Objects.
 *
 * The Durable Object's location is fixed at first creation and never
 * migrates, and this gateway runs BEFORE the room authenticates anything, so
 * a hint taken straight from an anonymous request would let first-touch
 * traffic pin a workspace's room wherever the caller chose for the room's
 * whole life. This is a signature-level check only — the room still performs
 * the full authorization after routing — and it fails closed: a deployment
 * without verifiable key material, or a caller authenticated through a custom
 * `tokenVerifier` the gateway cannot see, proves nothing and gets the
 * configured hint.
 */
async function relayPlacementCredential(
  request: Request,
  env: WorkspaceRelayDurableObjectEnv,
  url: URL,
  workspaceId: string,
): Promise<RelayPlacementCredential | undefined> {
  const key = await placementAuthKey(env)
  if (!key) return undefined
  try {
    if (url.pathname.startsWith("/host-tunnels/")) {
      const hostId = trimToUndefined(hostIdFromTunnelPath(url.pathname))
      const token = bearerToken(request.headers.get("authorization"))
      if (!hostId || !token) return undefined
      await verifyHostTunnelToken(token, key, { hostId, workspaceIds: workspaceIdsFromSearch(url) })
      return { hostId }
    }
    const token = runtimeAccessTokenFrom(request)
    if (!token) return undefined
    const claims = await verifyRuntimeAccessToken(token, key, { workspaceId })
    return { hostId: claims.host_id }
  } catch {
    return undefined
  }
}

/**
 * Where the gateway creates the room of the request's workspace. The room's
 * location is fixed at its first creation and never migrates, so this
 * decision is permanent for the workspace.
 */
export function workspaceRelayRoomPlacement(request: Request, env: WorkspaceRelayDurableObjectEnv, workspaceId: string) {
  return relayRoomPlacement(request, {
    ...(typeof env.CLAXEDO_RELAY_LOCATION_HINT === "string" ? { configured: env.CLAXEDO_RELAY_LOCATION_HINT } : {}),
    credential: () => relayPlacementCredential(request, env, new URL(request.url), workspaceId),
  })
}
