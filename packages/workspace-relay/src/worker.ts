import { createRemoteJWKSet, exportJWK, importJWK, importPKCS8, importSPKI } from "jose"
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
  createCachedRevocationClient,
  createCachedTargetClient,
  type RevocationLookup,
  type TargetLookup,
} from "./server"
import type { RelayKey, RuntimeAccessTokenClaims } from "./auth"

export type WorkspaceRelayWorkerEnv = Record<string, unknown> & {
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
  CLAXEDO_APP_ORIGINS?: string
  CLAXEDO_RELAY_ALLOWED_ORIGINS?: string
}

type ResolverClient = {
  target(workspaceId: string, hostId: string): Promise<WorkspaceRelayTarget | undefined>
  revocation(args: { jti: string; workspaceId: string; hostId: string }): Promise<RuntimeAccessTokenActiveResult>
}

type ResolverFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

function clean(input: unknown) {
  const value = typeof input === "string" ? input.trim() : undefined
  return value ? value : undefined
}

function positiveInteger(input: unknown) {
  const parsed = Number(clean(input))
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function sampleRate(input: unknown) {
  const parsed = Number(clean(input))
  if (!Number.isFinite(parsed)) return undefined
  if (parsed < 0) return 0
  if (parsed > 1) return 1
  return parsed
}

function pem(input: unknown) {
  return clean(input)?.replaceAll("\\n", "\n")
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

function requireText(env: WorkspaceRelayWorkerEnv, name: keyof WorkspaceRelayWorkerEnv & string) {
  const value = clean(env[name])
  if (!value) throw new Error(`${name} is required`)
  return value
}

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function deriveKidFromPublicKey(publicKey: CryptoKey) {
  const jwk = await exportJWK(publicKey)
  const material = String(jwk.x ?? jwk.n ?? "")
  if (!material) throw new Error("Cannot derive kid: public key has no public component")
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material))).slice(0, 16)
}

export function workspaceRelayWorkerResolverUrl(env: WorkspaceRelayWorkerEnv) {
  const resolverUrl = clean(env.CLAXEDO_RELAY_RESOLVER_URL)
  if (resolverUrl) return resolverUrl.replace(/\/+$/, "")
  const centralUrl = clean(env.CLAXEDO_CENTRAL_URL)
  if (centralUrl) return `${centralUrl.replace(/\/+$/, "")}/internal/relay`
  throw new Error("CLAXEDO_RELAY_RESOLVER_URL or CLAXEDO_CENTRAL_URL is required")
}

async function loadRuntimeAccessKey(env: WorkspaceRelayWorkerEnv): Promise<RelayKey> {
  const jwksUrl = clean(env.CLAXEDO_CONTROL_PLANE_JWKS_URL)
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
    : await importJWK(
        ((jwk) => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }))(await exportJWK(privateKey)),
        "EdDSA",
        { extractable: true },
      ) as CryptoKey
  const current: RelayHostPublicKey = {
    publicKey,
    kid: clean(env.CLAXEDO_RELAY_HOST_KID) ?? await deriveKidFromPublicKey(publicKey),
  }
  const nextPem = pem(env.CLAXEDO_RELAY_HOST_NEXT_PUBLIC_KEY_PEM)
  const nextPublicKey = nextPem ? await importSPKI(nextPem, "EdDSA", { extractable: true }) : undefined
  const next = nextPem
    ? {
        publicKey: nextPublicKey!,
        kid: clean(env.CLAXEDO_RELAY_HOST_NEXT_KID) ?? await deriveKidFromPublicKey(nextPublicKey!),
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
    return await res.json() as WorkspaceRelayTarget
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
    return await res.json() as RuntimeAccessTokenActiveResult
  }
  const targetCacheTtlMs = positiveInteger(env.CLAXEDO_RELAY_TARGET_CACHE_TTL_MS)
  const revocationCacheTtlMs = positiveInteger(env.CLAXEDO_RELAY_REVOCATION_CACHE_TTL_MS)
  const target = createCachedTargetClient(targetUncached, {
    ...(targetCacheTtlMs ? { ttlMs: targetCacheTtlMs } : {}),
  })
  const revocation = createCachedRevocationClient(revocationUncached, {
    ...(revocationCacheTtlMs ? { ttlMs: revocationCacheTtlMs } : {}),
  })
  return {
    target: (workspaceId, hostId) => target({ workspaceId, hostId }),
    revocation,
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
    auditAcceptSampleRate: Number(clean(env.CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE) ?? "0.1"),
    ...(positiveInteger(env.CLAXEDO_RELAY_TUNNEL_CHANNEL_CAP) ? { tunnelChannelCap: positiveInteger(env.CLAXEDO_RELAY_TUNNEL_CHANNEL_CAP) } : {}),
    ...(sampleRate(env.CLAXEDO_RELAY_TRACE_SAMPLE_RATE) !== undefined ? { traceSampleRate: sampleRate(env.CLAXEDO_RELAY_TRACE_SAMPLE_RATE) } : {}),
    ...(clean(env.CLAXEDO_RELAY_TRACE_FORCE_SECRET) ? { traceForceHeaderSecret: clean(env.CLAXEDO_RELAY_TRACE_FORCE_SECRET) } : {}),
    resolveTarget: (claims: RuntimeAccessTokenClaims) => resolver.target(claims.workspace_id, claims.host_id),
    isRuntimeAccessTokenActive: (claims: RuntimeAccessTokenClaims) =>
      resolver.revocation({
        jti: claims.jti,
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
      }),
    audit: (event) => {
      if (event.result === "deny") {
        console.warn(`[workspace-relay] deny ${event.action} reason=${event.reason ?? ""} workspace=${event.workspaceId ?? ""} path=${event.path}`)
      }
    },
  }
}

export class WorkspaceRelayRoom {
  private room?: ReturnType<typeof createWorkspaceRelayDurableObjectRoom>
  private loading?: Promise<ReturnType<typeof createWorkspaceRelayDurableObjectRoom>>

  constructor(
    private state: unknown,
    private env: WorkspaceRelayWorkerEnv,
  ) {}

  private hibernation(): WorkspaceRelayDurableObjectHibernation | undefined {
    const state = this.state as {
      acceptWebSocket?: (socket: WorkspaceRelayDurableObjectSocket) => void
      getWebSockets?: () => WorkspaceRelayDurableObjectSocket[]
    }
    if (!state.acceptWebSocket || !state.getWebSockets) return
    return {
      acceptWebSocket: (socket) => state.acceptWebSocket!(socket),
      getWebSockets: () => state.getWebSockets!(),
    }
  }

  /**
   * The DO alarm surface, used for the hibernation-safe revocation re-check.
   * Alarms are the only periodic mechanism that survives hibernation, so this is
   * what enforces revocation on an idle hibernated connection.
   */
  private alarms(): WorkspaceRelayDurableObjectAlarms | undefined {
    const storage = (this.state as {
      storage?: {
        getAlarm?: () => Promise<number | null>
        setAlarm?: (scheduledTime: number) => Promise<void>
        deleteAlarm?: () => Promise<void>
      }
    }).storage
    if (!storage?.getAlarm || !storage.setAlarm) return
    return {
      getAlarm: () => storage.getAlarm!(),
      setAlarm: (scheduledTime) => storage.setAlarm!(scheduledTime),
      ...(storage.deleteAlarm ? { deleteAlarm: () => storage.deleteAlarm!() } : {}),
    }
  }

  private async loadRoom() {
    setWorkspaceRelayAppOrigins(clean(this.env.CLAXEDO_APP_ORIGINS))
    setWorkspaceRelayAllowedOrigins(clean(this.env.CLAXEDO_RELAY_ALLOWED_ORIGINS))
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
    setWorkspaceRelayAppOrigins(clean(env.CLAXEDO_APP_ORIGINS))
    setWorkspaceRelayAllowedOrigins(clean(env.CLAXEDO_RELAY_ALLOWED_ORIGINS))
    if (new URL(request.url).pathname === "/.well-known/jwks.json") {
      return relayHostJwksResponse(env)
    }
    return gateway.fetch(request, env)
  },
}
