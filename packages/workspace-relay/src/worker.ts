import { createRemoteJWKSet, exportJWK, importPKCS8, importSPKI } from "jose"
import { trimToUndefined } from "@claxedo/helpers/string"
import {
  createWorkspaceRelayDurableObjectGateway,
  createWorkspaceRelayDurableObjectRoom,
  setWorkspaceRelayAppOrigins,
  setWorkspaceRelayAllowedOrigins,
  type WorkspaceRelayDurableObjectAlarms,
  type WorkspaceRelayDurableObjectHibernation,
  type WorkspaceRelayDurableObjectNamespace,
  type WorkspaceRelayDurableObjectRoomOptions,
  type WorkspaceRelayDurableObjectSocket,
} from "./cloudflare"
import type { RelayHostPublicKey, RuntimeAccessTokenActiveResult, WorkspaceRelayTarget } from "./server"
import {
  createCachedHostGenerationClient,
  createCachedRevocationClient,
  createCachedTargetClient,
  createHostGenerationResolverLookup,
  parseRuntimeAccessTokenActiveResult,
  parseWorkspaceRelayTarget,
  type HostGenerationLookup,
  type RevocationLookup,
  type TargetLookup,
} from "./server"
import { deriveRelayHostKid, deriveRelayHostPublicKey, type RelayKey, type RuntimeAccessTokenClaims } from "./auth"

type WorkspaceRelayWorkerBindings = {
  WORKSPACE_RELAY_ROOM?: WorkspaceRelayDurableObjectNamespace
  CLAXEDO_RELAY_RESOLVER_URL?: string
  CLAXEDO_CENTRAL_URL?: string
  CLAXEDO_RELAY_RESOLVER_TOKEN?: string
  CLAXEDO_CONTROL_PLANE_JWKS_URL?: string
  CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM?: string
  CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM?: string
  CLAXEDO_RELAY_HOST_PUBLIC_KEY_PEM?: string
  CLAXEDO_RELAY_HOST_NEXT_PUBLIC_KEY_PEM?: string
  CLAXEDO_RELAY_HOST_KID?: string
  CLAXEDO_RELAY_HOST_NEXT_KID?: string
  CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE?: string
  CLAXEDO_RELAY_TUNNEL_CHANNEL_CAP?: string
  CLAXEDO_RELAY_TRACE_SAMPLE_RATE?: string
  CLAXEDO_RELAY_TRACE_FORCE_SECRET?: string
  CLAXEDO_RELAY_REVOCATION_CACHE_TTL_MS?: string
  CLAXEDO_RELAY_TARGET_CACHE_TTL_MS?: string
  /**
   * Absolute URL of the control plane's host-generation lookup. Unset derives
   * `<resolver base>/host-generation` from the same base `/target` and
   * `/revocation` are derived from.
   */
  CLAXEDO_RELAY_HOST_GENERATION_URL?: string
  CLAXEDO_RELAY_HOST_GENERATION_CACHE_TTL_MS?: string
  CLAXEDO_APP_ORIGINS?: string
  CLAXEDO_RELAY_ALLOWED_ORIGINS?: string
}

export type WorkspaceRelayWorkerEnv = Record<string, unknown> & WorkspaceRelayWorkerBindings

type ResolverClient = {
  target(workspaceId: string, hostId: string): Promise<WorkspaceRelayTarget | undefined>
  revocation(args: { jti: string; workspaceId: string; hostId: string }): Promise<RuntimeAccessTokenActiveResult>
  hostGeneration: HostGenerationLookup
}

type ResolverFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

function positiveInteger(input: unknown) {
  const parsed = Number(trimToUndefined(input))
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function sampleRate(input: unknown) {
  const parsed = Number(trimToUndefined(input))
  if (!Number.isFinite(parsed)) return undefined
  if (parsed < 0) return 0
  if (parsed > 1) return 1
  return parsed
}

function pem(input: unknown) {
  return trimToUndefined(input)?.replaceAll("\\n", "\n")
}

function json(code: string, message: string, status = 503) {
  return Response.json({ error: { code, message } }, { status })
}

async function relayHostJwksResponse(env: WorkspaceRelayWorkerEnv) {
  const relayHost = await loadRelayHostKeys(env)
  const keys = await Promise.all(relayHost.publicKeys.map(async (source) => ({
    ...await exportJWK(source.publicKey),
    kid: source.kid,
    alg: "EdDSA",
    use: "sig",
  })))
  return Response.json({ keys }, {
    headers: { "cache-control": "public, max-age=300" },
  })
}

function requireText(env: WorkspaceRelayWorkerEnv, name: keyof WorkspaceRelayWorkerBindings) {
  const value = trimToUndefined(env[name])
  if (!value) throw new Error(`${name} is required`)
  return value
}

export function workspaceRelayWorkerResolverUrl(env: WorkspaceRelayWorkerEnv) {
  const resolverUrl = trimToUndefined(env.CLAXEDO_RELAY_RESOLVER_URL)
  if (resolverUrl) return resolverUrl.replace(/\/+$/, "")
  const centralUrl = trimToUndefined(env.CLAXEDO_CENTRAL_URL)
  if (centralUrl) return `${centralUrl.replace(/\/+$/, "")}/internal/relay`
  throw new Error("CLAXEDO_RELAY_RESOLVER_URL or CLAXEDO_CENTRAL_URL is required")
}

async function loadRuntimeAccessKey(env: WorkspaceRelayWorkerEnv): Promise<RelayKey> {
  const jwksUrl = trimToUndefined(env.CLAXEDO_CONTROL_PLANE_JWKS_URL)
  if (jwksUrl) return createRemoteJWKSet(new URL(jwksUrl))
  const publicPem = pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)
  if (!publicPem) {
    throw new Error("CLAXEDO_CONTROL_PLANE_JWKS_URL or CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM is required")
  }
  return importSPKI(publicPem, "EdDSA")
}

async function loadRelayHostKeys(env: WorkspaceRelayWorkerEnv) {
  const privatePem = pem(env.CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM)
  if (!privatePem) throw new Error("CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM is required")
  const privateKey = await importPKCS8(privatePem, "EdDSA", { extractable: true })
  const explicitPublicPem = pem(env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_PEM)
  const publicKey = explicitPublicPem
    ? await importSPKI(explicitPublicPem, "EdDSA", { extractable: true })
    : await deriveRelayHostPublicKey(privateKey)
  const current: RelayHostPublicKey = {
    publicKey,
    kid: trimToUndefined(env.CLAXEDO_RELAY_HOST_KID) ?? await deriveRelayHostKid(publicKey),
  }
  const nextPem = pem(env.CLAXEDO_RELAY_HOST_NEXT_PUBLIC_KEY_PEM)
  const nextPublicKey = nextPem ? await importSPKI(nextPem, "EdDSA", { extractable: true }) : undefined
  const next = nextPublicKey
    ? {
      publicKey: nextPublicKey,
      kid: trimToUndefined(env.CLAXEDO_RELAY_HOST_NEXT_KID) ?? await deriveRelayHostKid(nextPublicKey),
      }
    : undefined
  return { privateKey, publicKeys: next ? [current, next] : [current], currentKid: current.kid }
}

export function workspaceRelayWorkerResolverClient(env: WorkspaceRelayWorkerEnv, fetcher: ResolverFetch = fetch): ResolverClient {
  const root = workspaceRelayWorkerResolverUrl(env)
  const token = requireText(env, "CLAXEDO_RELAY_RESOLVER_TOKEN")
  const headers = { accept: "application/json", authorization: `Bearer ${token}` }
  const targetUncached: TargetLookup = async ({ workspaceId, hostId }) => {
    const url = new URL(`${root}/target`)
    url.searchParams.set("workspaceId", workspaceId)
    url.searchParams.set("hostId", hostId)
    const res = await fetcher(url, { headers })
    if (res.status === 404 || res.status === 409) return undefined
    if (!res.ok) throw new Error(`relay target resolver failed: ${res.status}`)
    const target = parseWorkspaceRelayTarget(await res.json())
    if (!target) throw new Error("relay target resolver returned a malformed target")
    return target
  }
  const revocationUncached: RevocationLookup = async (args) => {
    const url = new URL(`${root}/revocation`)
    url.searchParams.set("jti", args.jti)
    url.searchParams.set("workspaceId", args.workspaceId)
    url.searchParams.set("hostId", args.hostId)
    const res = await fetcher(url, { headers })
    if (!res.ok) {
      return {
        active: false,
        code: "relay_revocation_resolver_unavailable",
        reason: `revocation resolver returned ${res.status}`,
      }
    }
    const result = parseRuntimeAccessTokenActiveResult(await res.json())
    if (!result) throw new Error("relay revocation resolver returned a malformed result")
    return result
  }
  const targetCacheTtlMs = positiveInteger(env.CLAXEDO_RELAY_TARGET_CACHE_TTL_MS)
  const revocationCacheTtlMs = positiveInteger(env.CLAXEDO_RELAY_REVOCATION_CACHE_TTL_MS)
  const target = createCachedTargetClient(targetUncached, (targetCacheTtlMs ? { ttlMs: targetCacheTtlMs } : {}))
  const revocation = createCachedRevocationClient(revocationUncached, (revocationCacheTtlMs ? { ttlMs: revocationCacheTtlMs } : {}))
  const hostGenerationCacheTtlMs = positiveInteger(env.CLAXEDO_RELAY_HOST_GENERATION_CACHE_TTL_MS)
  const hostGeneration = createCachedHostGenerationClient(
    createHostGenerationResolverLookup(
      trimToUndefined(env.CLAXEDO_RELAY_HOST_GENERATION_URL) ?? `${root}/host-generation`,
      { headers, fetch: fetcher },
    ),
    (hostGenerationCacheTtlMs ? { ttlMs: hostGenerationCacheTtlMs } : {}),
  )
  return {
    target: (workspaceId, hostId) => target({ workspaceId, hostId }),
    revocation,
    hostGeneration,
  }
}

export async function workspaceRelayDurableObjectOptions(
  env: WorkspaceRelayWorkerEnv,
): Promise<WorkspaceRelayDurableObjectRoomOptions> {
  const resolver = workspaceRelayWorkerResolverClient(env)
  const relayHost = await loadRelayHostKeys(env)
  return {
    runtimeAccessKey: await loadRuntimeAccessKey(env),
    relayHostSigningKey: relayHost.privateKey,
    relayHostAlgorithm: "EdDSA",
    relayHostPublicKeys: relayHost.publicKeys,
    relayHostMintKid: relayHost.currentKid,
    auditAcceptSampleRate: Number(trimToUndefined(env.CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE) ?? "0.1"),
    ...(positiveInteger(env.CLAXEDO_RELAY_TUNNEL_CHANNEL_CAP) ? { tunnelChannelCap: positiveInteger(env.CLAXEDO_RELAY_TUNNEL_CHANNEL_CAP) } : {}),
    ...(sampleRate(env.CLAXEDO_RELAY_TRACE_SAMPLE_RATE) !== undefined ? { traceSampleRate: sampleRate(env.CLAXEDO_RELAY_TRACE_SAMPLE_RATE) } : {}),
    ...(trimToUndefined(env.CLAXEDO_RELAY_TRACE_FORCE_SECRET) ? { traceForceHeaderSecret: trimToUndefined(env.CLAXEDO_RELAY_TRACE_FORCE_SECRET) } : {}),
    resolveTarget: (claims: RuntimeAccessTokenClaims) => resolver.target(claims.workspace_id, claims.host_id),
    isRuntimeAccessTokenActive: (claims: RuntimeAccessTokenClaims) =>
      resolver.revocation({
        jti: claims.jti,
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
      }),
    resolveHostGeneration: resolver.hostGeneration,
    audit: (event) => {
      if (event.result === "deny") {
        console.warn(`[workspace-relay] deny ${event.action} reason=${event.reason ?? ""} workspace=${event.workspaceId ?? ""} path=${event.path}`)
      }
    },
  }
}

/**
 * The `DurableObjectState` workerd hands a room, modelled structurally like the
 * rest of this package's Cloudflare surface (see `./cloudflare`) — this package
 * deliberately carries no `@cloudflare/workers-types` dependency.
 *
 * Everything is optional because `cloudflare.ts` treats hibernation and alarms
 * as capabilities to DETECT: an older runtime, or a harness standing in for
 * one, may provide neither, and the room degrades rather than failing.
 */
export type WorkspaceRelayRoomState = {
  acceptWebSocket?: (socket: WorkspaceRelayDurableObjectSocket) => void
  getWebSockets?: () => WorkspaceRelayDurableObjectSocket[]
  storage?: {
    getAlarm?: () => Promise<number | null>
    setAlarm?: (scheduledTime: number) => Promise<void>
    deleteAlarm?: () => Promise<void>
  }
}

export class WorkspaceRelayRoom {
  private room?: ReturnType<typeof createWorkspaceRelayDurableObjectRoom>
  private loading?: Promise<ReturnType<typeof createWorkspaceRelayDurableObjectRoom>>

  constructor(
    private state: WorkspaceRelayRoomState,
    private env: WorkspaceRelayWorkerEnv,
  ) {}

  private hibernation(): WorkspaceRelayDurableObjectHibernation | undefined {
    const state = this.state
    const { acceptWebSocket, getWebSockets } = state
    if (!acceptWebSocket || !getWebSockets) return undefined
    return {
      acceptWebSocket: (socket) => acceptWebSocket.call(state, socket),
      getWebSockets: () => getWebSockets.call(state),
    }
  }

  /**
   * The DO alarm surface, used for the hibernation-safe revocation re-check.
   * Alarms are the only periodic mechanism that survives hibernation, so this is
   * what enforces revocation on an idle hibernated connection.
   */
  private alarms(): WorkspaceRelayDurableObjectAlarms | undefined {
    const storage = this.state.storage
    if (!storage) return undefined
    const { getAlarm, setAlarm, deleteAlarm } = storage
    if (!getAlarm || !setAlarm) return undefined
    return {
      getAlarm: () => getAlarm.call(storage),
      setAlarm: (scheduledTime) => setAlarm.call(storage, scheduledTime),
      ...(deleteAlarm ? { deleteAlarm: () => deleteAlarm.call(storage) } : {}),
    }
  }

  private async loadRoom() {
    setWorkspaceRelayAppOrigins(trimToUndefined(this.env.CLAXEDO_APP_ORIGINS))
    setWorkspaceRelayAllowedOrigins(trimToUndefined(this.env.CLAXEDO_RELAY_ALLOWED_ORIGINS))
    if (this.room) return this.room
    this.loading ??= workspaceRelayDurableObjectOptions(this.env)
      .then((options) => createWorkspaceRelayDurableObjectRoom({
        ...options,
        ...(this.hibernation() ? { hibernation: this.hibernation() } : {}),
        ...(this.alarms() ? { alarms: this.alarms() } : {}),
      }))
    this.room = await this.loading
    return this.room
  }

  async fetch(request: Request) {
    try {
      // The room may run in a different isolate than the gateway Worker, so
      // configure the deployment app origins here too.
      return (await this.loadRoom()).fetch(request)
    } catch (err) {
      return json("relay_durable_object_boot_failed", err instanceof Error ? err.message : "Workspace relay room failed to boot")
    }
  }

  async webSocketMessage(socket: WorkspaceRelayDurableObjectSocket, message: string | ArrayBuffer) {
    return (await this.loadRoom()).webSocketMessage(socket, message)
  }

  async webSocketClose(socket: WorkspaceRelayDurableObjectSocket, code: number, reason: string, wasClean: boolean) {
    void wasClean
    return (await this.loadRoom()).webSocketClose(socket, code, reason)
  }

  async webSocketError(socket: WorkspaceRelayDurableObjectSocket, error: unknown) {
    void error
    return (await this.loadRoom()).webSocketError(socket)
  }

  /**
   * Forwarded so the room's hibernation-safe revocation sweep actually runs. The
   * DO has ONE alarm slot; the room only ever moves it earlier and never clears
   * it, so adding another alarm user here stays safe.
   */
  async alarm() {
    return (await this.loadRoom()).alarm()
  }
}

const gateway = createWorkspaceRelayDurableObjectGateway({ bindingName: "WORKSPACE_RELAY_ROOM" })

export default {
  fetch(request: Request, env: WorkspaceRelayWorkerEnv) {
    setWorkspaceRelayAppOrigins(trimToUndefined(env.CLAXEDO_APP_ORIGINS))
    setWorkspaceRelayAllowedOrigins(trimToUndefined(env.CLAXEDO_RELAY_ALLOWED_ORIGINS))
    if (new URL(request.url).pathname === "/.well-known/jwks.json") {
      return relayHostJwksResponse(env)
    }
    return gateway.fetch(request, env)
  },
}
