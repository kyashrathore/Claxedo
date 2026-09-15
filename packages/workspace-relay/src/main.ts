import { PostHog } from "posthog-node"
import {
  createRemoteJWKSet,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
  importSPKI,
} from "jose"
import { trimToUndefined } from "@claxedo/helpers/string"
import {
  createWorkspaceRelayBun,
  WORKSPACE_RELAY_IDLE_TIMEOUT_SECONDS,
  type WorkspaceRelayBunDrainController,
} from "./bun"
import { parseAllowedOrigins } from "./cors-origins"
import { createWorkspaceRelayDirectory, type WorkspaceRelayDirectory } from "./directory"
import { startSyntheticProbe, type SyntheticProbe } from "./synthetic"
import {
  createCachedHostGenerationClient,
  createCachedRevocationClient,
  createCachedTargetClient,
  createHostGenerationResolverLookup,
  parseRuntimeAccessTokenActiveResult,
  parseWorkspaceRelayTarget,
  type RelayHostPublicKey,
  type RevocationLookup,
  type TargetLookup,
  type WorkspaceRelayTarget,
} from "./server"
import {
  deriveRelayHostKid,
  deriveRelayHostPublicKey,
  type RelayKey,
  type RuntimeAccessTokenClaims,
} from "./auth"

export { createCachedRevocationClient, createCachedTargetClient } from "./server"

const BUN_TARGET_CACHE_TTL_MS_DEFAULT = 30_000
const BUN_REVOCATION_CACHE_TTL_MS_DEFAULT = 10_000
const BUN_HOST_GENERATION_CACHE_TTL_MS_DEFAULT = 10_000
const BUN_RUNTIME_ACCESS_TOKEN_CACHE_TTL_MS_DEFAULT = 10_000

function positiveInteger(input: string | undefined) {
  const parsed = Number(trimToUndefined(input))
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function pem(input: string | undefined) {
  return trimToUndefined(input)?.replaceAll("\\n", "\n")
}

function requireEnv(name: string) {
  const value = trimToUndefined(process.env[name])
  if (!value) {
    console.error(`[workspace-relay] missing required env: ${name}`)
    process.exit(2)
  }
  return value
}

/**
 * PostHog is the relay's error sink — one vendor carries error tracking for
 * every runtime behind one distinct_id space.
 *
 * Sending requires two independent opt-ins: `CLAXEDO_TELEMETRY_MODE=on` AND
 * `CLAXEDO_POSTHOG_KEY` (`POSTHOG_KEY` accepted as a fallback — the same
 * unprefixed name claxedo-server's posthog.ts reads). Any other combination
 * constructs no `PostHog` client: zero SDK overhead, zero network. Host
 * defaults to `https://us.i.posthog.com` (the ingest host, not the legacy
 * `app.posthog.com` default some SDKs ship). Release is the git SHA from
 * `CLAXEDO_RELEASE` (`GIT_SHA` accepted as alias); captures are tagged
 * unit=relay + deployment_mode (absent → "local").
 *
 * `posthog-node` runs fine on Bun (`Bun.serve`), unlike the Cloudflare
 * Worker, which keeps it off its import graph entirely (see worker.ts).
 */
export type RelayObservabilityEnv = {
  /** Only `on` permits sending, matched case-insensitively after trimming. */
  CLAXEDO_TELEMETRY_MODE?: string | undefined
  CLAXEDO_POSTHOG_KEY?: string | undefined
  POSTHOG_KEY?: string | undefined
  CLAXEDO_POSTHOG_HOST?: string | undefined
  CLAXEDO_RELEASE?: string | undefined
  GIT_SHA?: string | undefined
  CLAXEDO_DEPLOYMENT_MODE?: string | undefined
  /** Accept process.env verbatim (extra keys are ignored). */
  [key: string]: string | undefined
}

export type RelayTelemetryOptions = {
  key: string
  host: string
  release?: string
  tags: { unit: "relay"; deployment_mode: string }
}

/**
 * Pure env → PostHog options resolver. `undefined` = do NOT construct a client
 * (no client, no network), which is the answer unless BOTH opt-ins are
 * present. The mode is read before the key so that a deployment which has not
 * said `on` stays silent no matter which keys reach its environment.
 * Exported for tests.
 */
export function relayTelemetryOptions(env: RelayObservabilityEnv): RelayTelemetryOptions | undefined {
  if (trimToUndefined(env.CLAXEDO_TELEMETRY_MODE)?.toLowerCase() !== "on") return undefined
  const key = trimToUndefined(env.CLAXEDO_POSTHOG_KEY) ?? trimToUndefined(env.POSTHOG_KEY)
  if (!key) return undefined
  const release = trimToUndefined(env.CLAXEDO_RELEASE) ?? trimToUndefined(env.GIT_SHA)
  return {
    key,
    host: trimToUndefined(env.CLAXEDO_POSTHOG_HOST) ?? "https://us.i.posthog.com",
    ...(release ? { release } : {}),
    tags: {
      unit: "relay",
      deployment_mode: trimToUndefined(env.CLAXEDO_DEPLOYMENT_MODE)?.toLowerCase() ?? "local",
    },
  }
}

// The PostHog client is an explicit object with no ambient global, so
// reportFatal needs somewhere to find the one instance
// initRelayObservability constructed. Stays undefined unless both opt-ins are
// present — that's the no-client guarantee those tests assert on.
let relayPostHogClient: PostHog | undefined
let relayPostHogTags: Record<string, string> = {}

export function initRelayObservability(env: RelayObservabilityEnv = process.env): { enabled: boolean } {
  const options = relayTelemetryOptions(env)
  if (!options) return { enabled: false }
  relayPostHogClient = new PostHog(options.key, { host: options.host })
  relayPostHogTags = { ...options.tags, ...(options.release ? { release: options.release } : {}) }
  return { enabled: true }
}

/**
 * Capture-and-flush used by the fatal handlers and the startup catch. With no
 * initialized client (key absent) this is a documented no-op. Never throws —
 * observability must not preempt the exit path.
 *
 * `distinctId: "system"` mirrors the ops-plane convention: process-fatal
 * events carry no user identity. `client.flush()` has no built-in timeout,
 * so it races a 2s timer; the flush promise's
 * rejection is swallowed even when the timer wins the race, so a slow network
 * failure that resolves after the timeout never surfaces as a second
 * unhandledRejection mid-shutdown.
 */
export async function reportFatal(error: unknown): Promise<void> {
  try {
    const client = relayPostHogClient
    if (!client) return
    client.captureException(error, "system", relayPostHogTags)
    await Promise.race([
      client.flush().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ])
  } catch {
    // Never let error reporting block shutdown.
  }
}

/**
 * Production fail-closed gate for the relay → claxedo-server resolver channel.
 *
 * If `CLAXEDO_RELAY_RESOLVER_TOKEN` is missing/empty in production the relay
 * would otherwise call the resolver unauthenticated. Refuse to boot.
 *
 * Allowed in dev/test for ergonomics — the resolver itself falls back to a
 * loopback-only check when no token is configured.
 */
export type ValidateProductionEnvInput = {
  NODE_ENV?: string | undefined
  CLAXEDO_RELAY_RESOLVER_TOKEN?: string | undefined
}

export type ValidateProductionEnvResult =
  | { ok: true }
  | { ok: false; exitCode: 2; message: string }

export function validateProductionEnv(env: ValidateProductionEnvInput): ValidateProductionEnvResult {
  const isProduction = trimToUndefined(env.NODE_ENV) === "production"
  if (!isProduction) return { ok: true }
  const resolverToken = trimToUndefined(env.CLAXEDO_RELAY_RESOLVER_TOKEN)
  if (!resolverToken) {
    return {
      ok: false,
      exitCode: 2,
      message:
        "CLAXEDO_RELAY_RESOLVER_TOKEN is required in production to authenticate the relay → claxedo-server channel",
    }
  }
  return { ok: true }
}

/**
 * Resolve the verification key (or keyset resolver) for Runtime Access Tokens.
 *
 * Precedence: `CLAXEDO_CONTROL_PLANE_JWKS_URL` > `CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM`.
 * The PEM env var is kept as a fallback so JWKS rollouts can ship gradually.
 *
 * Exported for tests.
 */
export type LoadRuntimeAccessKeyEnv = {
  CLAXEDO_CONTROL_PLANE_JWKS_URL?: string | undefined
  CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM?: string | undefined
}

export async function loadRuntimeAccessKeyOrJwks(env: LoadRuntimeAccessKeyEnv): Promise<RelayKey> {
  const jwksUrl = trimToUndefined(env.CLAXEDO_CONTROL_PLANE_JWKS_URL)
  if (jwksUrl) {
    // Throws TypeError on malformed URL — surfaced to the caller.
    return createRemoteJWKSet(new URL(jwksUrl))
  }
  const verifyPem = pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)
  if (!verifyPem) {
    throw new Error(
      "Runtime Access Token verification key is not configured: set CLAXEDO_CONTROL_PLANE_JWKS_URL or CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM",
    )
  }
  return importSPKI(verifyPem, "EdDSA")
}

/**
 * Resolve the RHT key material — both the private key used to sign RHTs and
 * the public key(s) we publish at `/.well-known/jwks.json`.
 *
 * Precedence for the public counterpart:
 *   1. `CLAXEDO_RELAY_HOST_PUBLIC_KEY_PEM` (explicit override; useful when
 *      the private key is held in an HSM-style import that strips public bits).
 *   2. Derived from the private key via `exportJWK` (works because we now
 *      load the private key with `extractable: true`).
 *
 * `kid` is the explicit `CLAXEDO_RELAY_HOST_KID` env var if set, otherwise
 * SHA-256(public-key-x).slice(0, 16). Mint and JWKS use the same derivation
 * so they always agree.
 *
 * `next` is optional and is included in JWKS only — never used to mint. It
 * exists to support rolling rotation: publish the next key, drain the
 * current one, swap signing key, retire the old.
 *
 * Exported for tests.
 */
export type LoadRelayHostKeyMaterialEnv = {
  /**
   * Gates the production fail-closed check: with no signing-key PEM in
   * `production` the loader exits 2 instead of generating an ephemeral key.
   * The check lives here rather than in `validateProductionEnv` because the
   * loader already inspects the signing-key env var.
   */
  NODE_ENV?: string | undefined
  CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM?: string | undefined
  CLAXEDO_RELAY_HOST_PUBLIC_KEY_PEM?: string | undefined
  CLAXEDO_RELAY_HOST_NEXT_PUBLIC_KEY_PEM?: string | undefined
  CLAXEDO_RELAY_HOST_KID?: string | undefined
  CLAXEDO_RELAY_HOST_NEXT_KID?: string | undefined
}

export type RelayHostKeyMaterial = {
  privateKey: CryptoKey
  current: RelayHostPublicKey
  next?: RelayHostPublicKey
}

export async function loadRelayHostKeyMaterial(env: LoadRelayHostKeyMaterialEnv): Promise<RelayHostKeyMaterial> {
  const privatePem = pem(env.CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM)
  let privateKey: CryptoKey
  let derivedPublicKey: CryptoKey | undefined
  if (privatePem) {
    privateKey = (await importPKCS8(privatePem, "EdDSA", { extractable: true }))
  } else {
    // Refuse to boot in production with an ephemeral key. Each instance
    // would generate a different key, so RHTs minted by one instance would
    // be unverifiable by another, and the public JWKS would lie about which
    // key is in use.
    if (trimToUndefined(env.NODE_ENV) === "production") {
      console.error(
        "[workspace-relay] CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM required in production; refusing to start with an ephemeral key",
      )
      process.exit(2)
    }
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    privateKey = pair.privateKey
    derivedPublicKey = pair.publicKey
    console.log("[workspace-relay] generated ephemeral relay-host signing key (no PEM provided)")
  }

  const explicitPublicPem = pem(env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_PEM)
  let publicKey: CryptoKey
  if (explicitPublicPem) {
    publicKey = (await importSPKI(explicitPublicPem, "EdDSA", { extractable: true }))
  } else if (derivedPublicKey) {
    publicKey = derivedPublicKey
  } else {
    // Derive public from private via JWK round-trip. importPKCS8 with
    // extractable: true gives us a key that can be exported as JWK; we then
    // re-import the public component as a pure public key.
    publicKey = await deriveRelayHostPublicKey(privateKey)
  }

  const explicitCurrentKid = trimToUndefined(env.CLAXEDO_RELAY_HOST_KID)
  const currentKid = explicitCurrentKid ?? (await deriveRelayHostKid(publicKey))

  const nextPem = pem(env.CLAXEDO_RELAY_HOST_NEXT_PUBLIC_KEY_PEM)
  let next: RelayHostPublicKey | undefined
  if (nextPem) {
  const nextPublicKey = (await importSPKI(nextPem, "EdDSA", { extractable: true }))
  const explicitNextKid = trimToUndefined(env.CLAXEDO_RELAY_HOST_NEXT_KID)
    next = {
      publicKey: nextPublicKey,
      kid: explicitNextKid ?? (await deriveRelayHostKid(nextPublicKey)),
    }
  }

  return {
    privateKey,
    current: { publicKey, kid: currentKid },
    ...(next ? { next } : {}),
  }
}

/**
 * Parse `CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE` into a number in [0, 1].
 * Falls back to a NODE_ENV-gated default (production: 0.1, dev/test: 1.0) if
 * unset, empty, or out of range. Exported for tests.
 */
export type ParseAuditAcceptSampleRateEnv = {
  CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE?: string | undefined
  NODE_ENV?: string | undefined
}

export function parseAuditAcceptSampleRate(env: ParseAuditAcceptSampleRateEnv): number {
  const isProduction = trimToUndefined(env.NODE_ENV) === "production"
  const fallback = isProduction ? 0.1 : 1
  const raw = trimToUndefined(env.CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE)
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  if (value < 0 || value > 1) return fallback
  return value
}

/**
 * Parse the `CLAXEDO_RELAY_METRICS_TOKEN` env var. Returns `undefined`
 * for missing/empty/whitespace-only values so the relay can fall back to its
 * loopback-only `/metrics` access policy.
 */
export type ParseMetricsTokenEnv = {
  CLAXEDO_RELAY_METRICS_TOKEN?: string | undefined
}

export function parseMetricsToken(env: ParseMetricsTokenEnv): string | undefined {
  return trimToUndefined(env.CLAXEDO_RELAY_METRICS_TOKEN)
}

export type RuntimeAccessTokenCacheEnv = {
  CLAXEDO_RELAY_RUNTIME_ACCESS_TOKEN_CACHE_TTL_MS?: string | undefined
}

export function runtimeAccessTokenCacheTtlMsFromEnv(env: RuntimeAccessTokenCacheEnv): number {
  return positiveInteger(env.CLAXEDO_RELAY_RUNTIME_ACCESS_TOKEN_CACHE_TTL_MS)
    ?? BUN_RUNTIME_ACCESS_TOKEN_CACHE_TTL_MS_DEFAULT
}

export type DirectHttpConcurrencyEnv = {
  CLAXEDO_RELAY_DIRECT_HTTP_CONCURRENCY?: string | undefined
}

export function directHttpConcurrencyFromEnv(env: DirectHttpConcurrencyEnv): number | undefined {
  return positiveInteger(env.CLAXEDO_RELAY_DIRECT_HTTP_CONCURRENCY)
}

export type ResolverClientCacheOptions = {
  targetCacheTtlMs?: number
  revocationCacheTtlMs?: number
  /**
   * Absolute URL of the control plane's host-generation lookup. Unset derives
   * `<resolver base>/host-generation`, the route every resolver base serves
   * next to `/target` and `/revocation`.
   */
  hostGenerationUrl?: string
  hostGenerationCacheTtlMs?: number
}

export type ResolverClientCacheEnv = {
  CLAXEDO_RELAY_TARGET_CACHE_TTL_MS?: string | undefined
  CLAXEDO_RELAY_REVOCATION_CACHE_TTL_MS?: string | undefined
  CLAXEDO_RELAY_HOST_GENERATION_URL?: string | undefined
  CLAXEDO_RELAY_HOST_GENERATION_CACHE_TTL_MS?: string | undefined
}

export function resolverClientCacheOptionsFromEnv(env: ResolverClientCacheEnv): ResolverClientCacheOptions {
  const hostGenerationUrl = trimToUndefined(env.CLAXEDO_RELAY_HOST_GENERATION_URL)
  return {
    targetCacheTtlMs: positiveInteger(env.CLAXEDO_RELAY_TARGET_CACHE_TTL_MS) ?? BUN_TARGET_CACHE_TTL_MS_DEFAULT,
    revocationCacheTtlMs: positiveInteger(env.CLAXEDO_RELAY_REVOCATION_CACHE_TTL_MS) ?? BUN_REVOCATION_CACHE_TTL_MS_DEFAULT,
    ...(hostGenerationUrl ? { hostGenerationUrl } : {}),
    hostGenerationCacheTtlMs: positiveInteger(env.CLAXEDO_RELAY_HOST_GENERATION_CACHE_TTL_MS) ?? BUN_HOST_GENERATION_CACHE_TTL_MS_DEFAULT,
  }
}

export function createResolverClient(
  baseUrl: string,
  token: string | undefined,
  options: ResolverClientCacheOptions = {},
) {
  const headers: Record<string, string> = { accept: "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  const root = baseUrl.replace(/\/+$/, "")
  const targetUncached: TargetLookup = async (args) => {
    const url = new URL(`${root}/target`)
    url.searchParams.set("workspaceId", args.workspaceId)
    url.searchParams.set("hostId", args.hostId)
    const res = await fetch(url, { headers })
    if (res.status === 404) return undefined
    if (!res.ok) throw new Error(`relay target resolver failed: ${res.status} ${await res.text()}`)
    // Same boundary parse the Cloudflare worker applies (`worker.ts`): the
    // resolver is a remote service, so its body is validated once here rather
    // than trusted into `WorkspaceRelayTarget`.
    const target = parseWorkspaceRelayTarget(await res.json())
    if (!target) throw new Error("relay target resolver returned a malformed target")
    return target
  }
  const revocationUncached: RevocationLookup = async (args) => {
    const url = new URL(`${root}/revocation`)
    url.searchParams.set("jti", args.jti)
    url.searchParams.set("workspaceId", args.workspaceId)
    url.searchParams.set("hostId", args.hostId)
    const res = await fetch(url, { headers })
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
  const target = createCachedTargetClient(targetUncached, {
    ttlMs: options.targetCacheTtlMs ?? BUN_TARGET_CACHE_TTL_MS_DEFAULT,
  })
  const revocation = createCachedRevocationClient(revocationUncached, {
    ttlMs: options.revocationCacheTtlMs ?? BUN_REVOCATION_CACHE_TTL_MS_DEFAULT,
  })
  const hostGeneration = createCachedHostGenerationClient(
    createHostGenerationResolverLookup(options.hostGenerationUrl ?? `${root}/host-generation`, { headers }),
    { ttlMs: options.hostGenerationCacheTtlMs ?? BUN_HOST_GENERATION_CACHE_TTL_MS_DEFAULT },
  )
  return {
    target: (workspaceId: string, hostId: string): Promise<WorkspaceRelayTarget | undefined> => target({ workspaceId, hostId }),
    revocation,
    hostGeneration,
  }
}

const STOP_SERVER_TIMEOUT_MS_DEFAULT = 5_000

/**
 * Run a teardown step, but never let it hold the process open.
 *
 * Both shutdown paths exist to exit *deterministically*: a SIGTERM drain has
 * the platform's kill timeout behind it, and a fatal handler is already
 * running on a process we have declared broken. `stopServer` is awaited on
 * purpose (T9) so sockets are really closed before exit — but a socket that
 * never finishes closing must not turn a graceful exit into a SIGKILL, which
 * would skip `directory.dispose()` and the exit code entirely. Same bound, and
 * the same reason, as `reportFatal`'s flush race above.
 *
 * A rejection that arrives *after* the bound expires is logged, not thrown:
 * by then we have already moved on, and an unhandled rejection inside the
 * fatal handler would be a second crash on top of the first.
 */
async function runBoundedTeardown(
  step: (() => Promise<void> | void) | undefined,
  label: string,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<void> {
  if (!step) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const attempt = (async () => {
    await step()
  })().catch((err: unknown) => {
    log(`[workspace-relay] ${label} failed: ${err instanceof Error ? err.message : String(err)}`)
  })
  try {
    await Promise.race([
      attempt,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log(`[workspace-relay] ${label} did not finish within ${timeoutMs}ms; exiting anyway`)
          resolve()
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Graceful SIGTERM drain wiring.
 *
 * On `SIGTERM` (or `SIGINT` for local dev) the relay must:
 *   1. Flip the drain flag so `/health` reports 503 and Fly removes the
 *      machine from routing, and so new HTTP requests + tunnel registrations
 *      fast-path to 503 before doing any auth or upstream work.
 *   2. Wait up to `drainTimeoutMs` (default 30 s, override via
 *      `CLAXEDO_RELAY_DRAIN_TIMEOUT_MS`) for the in-flight tunnel HTTP
 *      response map to empty across every connected host tunnel.
 *   3. Release the directory's TTL sweep timer via `directory.dispose()` so
 *      the process can exit cleanly without a dangling `setInterval`.
 *   4. Exit with code 0.
 *
 * Exposed for tests so the trigger logic can be exercised without actually
 * raising signals or stopping the process. Pass `register: false` in tests
 * to skip the real `process.on(...)` registration.
 */
export type ShutdownDrainHandlerOptions = {
  drain: WorkspaceRelayBunDrainController
  directory: Pick<WorkspaceRelayDirectory, "dispose">
  drainTimeoutMs: number
  /** Defaults to `process.exit`. Override for tests. */
  exit?: (code?: number) => void
  /** Defaults to a no-op log. */
  log?: (message: string) => void
  /** When true (default), register `SIGTERM` and `SIGINT` handlers on `process`. */
  register?: boolean
  /** Signals to listen for. Defaults to `["SIGTERM", "SIGINT"]`. */
  signals?: NodeJS.Signals[]
  /** Defaults to a no-op (we let Bun.serve get GC'd as part of process exit). */
  stopServer?: () => Promise<void> | void
  /**
   * Upper bound on `stopServer`. A wedged socket close must not outlast the
   * platform's kill timeout, or a graceful exit becomes a SIGKILL that skips
   * `directory.dispose()`. Defaults to 5 s; tests override it to stay fast.
   */
  stopTimeoutMs?: number
}

export type ShutdownDrainHandle = {
  trigger(): Promise<void>
  isShuttingDown(): boolean
}

export function installShutdownDrainHandler(options: ShutdownDrainHandlerOptions): ShutdownDrainHandle {
  const exit = options.exit ?? ((code?: number) => process.exit(code))
  const log = options.log ?? (() => {})
  const register = options.register ?? true
  const signals = options.signals ?? (["SIGTERM", "SIGINT"] as NodeJS.Signals[])

  let shuttingDown = false
  let pending: Promise<void> | undefined

  async function trigger(): Promise<void> {
    if (pending) return pending
    shuttingDown = true
    pending = (async () => {
      log("[workspace-relay] drain start")
      options.drain.setDraining(true)
      const result = await options.drain.waitForDrain(options.drainTimeoutMs)
      if (result.drained) {
        log(`[workspace-relay] drained cleanly`)
      } else {
        log(
          `[workspace-relay] drain timeout: ${result.remaining} pending request(s) remaining after ${options.drainTimeoutMs}ms; force-closing`,
        )
      }
      await runBoundedTeardown(
        options.stopServer,
        "stopServer",
        options.stopTimeoutMs ?? STOP_SERVER_TIMEOUT_MS_DEFAULT,
        log,
      )
      try {
        options.directory.dispose()
      } catch (err) {
        log(`[workspace-relay] directory.dispose() failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      exit(0)
    })()
    return pending
  }

  if (register) {
    for (const signal of signals) {
      process.on(signal, () => {
        void trigger()
      })
    }
  }

  return {
    trigger,
    isShuttingDown: () => shuttingDown,
  }
}

export type FatalProcessHandlerOptions = {
  drain: WorkspaceRelayBunDrainController
  directory: Pick<WorkspaceRelayDirectory, "dispose">
  exit?: (code?: number) => void
  log?: (message: string) => void
  register?: boolean
  /**
   * Error-tracker hook, invoked (and awaited) before teardown so a fatal
   * crash reaches PostHog before the process exits. Failures are logged and
   * never block the exit path. Defaults to none (tests, key-absent runs).
   */
  report?: (error: unknown, source: "uncaughtException" | "unhandledRejection") => void | Promise<void>
  stopServer?: () => Promise<void> | void
  /** Upper bound on `stopServer`; see `ShutdownDrainHandlerOptions.stopTimeoutMs`. */
  stopTimeoutMs?: number
}

export type FatalProcessHandle = {
  trigger(error: unknown, source: "uncaughtException" | "unhandledRejection"): Promise<void>
  isFatal(): boolean
}

export function installFatalProcessHandlers(options: FatalProcessHandlerOptions): FatalProcessHandle {
  const exit = options.exit ?? ((code?: number) => process.exit(code))
  const log = options.log ?? (() => {})
  const register = options.register ?? true
  let fatal = false
  let pending: Promise<void> | undefined

  async function trigger(error: unknown, source: "uncaughtException" | "unhandledRejection") {
    if (pending) return pending
    fatal = true
    pending = (async () => {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      log(`[workspace-relay] fatal ${source}: ${message}`)
      try {
        await options.report?.(error, source)
      } catch (err) {
        log(`[workspace-relay] fatal report failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      options.drain.setDraining(true)
      await runBoundedTeardown(
        options.stopServer,
        "fatal stopServer",
        options.stopTimeoutMs ?? STOP_SERVER_TIMEOUT_MS_DEFAULT,
        log,
      )
      try {
        options.directory.dispose()
      } catch (err) {
        log(`[workspace-relay] fatal directory.dispose() failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      exit(1)
    })()
    return pending
  }

  if (register) {
    process.on("uncaughtException", (err) => {
      void trigger(err, "uncaughtException")
    })
    process.on("unhandledRejection", (err) => {
      void trigger(err, "unhandledRejection")
    })
  }

  return {
    trigger,
    isFatal: () => fatal,
  }
}

async function main() {
  // PostHog first so every later runtime error reaches the tracker; env
  // validation failures already report on stderr. No-op unless both opt-ins
  // are set.
  const observability = initRelayObservability(process.env)
  if (observability.enabled) {
    console.log("[workspace-relay] posthog error tracking enabled")
  }

  const validation = validateProductionEnv({
    NODE_ENV: process.env.NODE_ENV,
    CLAXEDO_RELAY_RESOLVER_TOKEN: process.env.CLAXEDO_RELAY_RESOLVER_TOKEN,
  })
  if (!validation.ok) {
    console.error(`[workspace-relay] ${validation.message}`)
    process.exit(validation.exitCode)
  }

  const port = Number(trimToUndefined(process.env.CLAXEDO_WORKSPACE_RELAY_PORT) ?? "7777")
  if (!Number.isFinite(port) || port <= 0) {
    console.error(`[workspace-relay] invalid CLAXEDO_WORKSPACE_RELAY_PORT: ${process.env.CLAXEDO_WORKSPACE_RELAY_PORT}`)
    process.exit(2)
  }
  const hostname = trimToUndefined(process.env.CLAXEDO_WORKSPACE_RELAY_HOST) ?? "127.0.0.1"
  const resolverUrl = requireEnv("CLAXEDO_RELAY_RESOLVER_URL")
  const resolverToken = trimToUndefined(process.env.CLAXEDO_RELAY_RESOLVER_TOKEN)

  let runtimeAccessKey: RelayKey
  try {
    runtimeAccessKey = await loadRuntimeAccessKeyOrJwks({
      CLAXEDO_CONTROL_PLANE_JWKS_URL: process.env.CLAXEDO_CONTROL_PLANE_JWKS_URL,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM,
    })
  } catch (err) {
    console.error(`[workspace-relay] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
  let relayHostMaterial: RelayHostKeyMaterial
  try {
    relayHostMaterial = await loadRelayHostKeyMaterial({
      NODE_ENV: process.env.NODE_ENV,
      CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: process.env.CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM,
      CLAXEDO_RELAY_HOST_PUBLIC_KEY_PEM: process.env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_PEM,
      CLAXEDO_RELAY_HOST_NEXT_PUBLIC_KEY_PEM: process.env.CLAXEDO_RELAY_HOST_NEXT_PUBLIC_KEY_PEM,
      CLAXEDO_RELAY_HOST_KID: process.env.CLAXEDO_RELAY_HOST_KID,
      CLAXEDO_RELAY_HOST_NEXT_KID: process.env.CLAXEDO_RELAY_HOST_NEXT_KID,
    })
  } catch (err) {
    console.error(`[workspace-relay] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
  const relayHostSigningKey = relayHostMaterial.privateKey
  const relayHostPublicKeys: RelayHostPublicKey[] = [relayHostMaterial.current]
  if (relayHostMaterial.next) relayHostPublicKeys.push(relayHostMaterial.next)
  const resolver = createResolverClient(resolverUrl, resolverToken, resolverClientCacheOptionsFromEnv({
    CLAXEDO_RELAY_TARGET_CACHE_TTL_MS: process.env.CLAXEDO_RELAY_TARGET_CACHE_TTL_MS,
    CLAXEDO_RELAY_REVOCATION_CACHE_TTL_MS: process.env.CLAXEDO_RELAY_REVOCATION_CACHE_TTL_MS,
    CLAXEDO_RELAY_HOST_GENERATION_URL: process.env.CLAXEDO_RELAY_HOST_GENERATION_URL,
    CLAXEDO_RELAY_HOST_GENERATION_CACHE_TTL_MS: process.env.CLAXEDO_RELAY_HOST_GENERATION_CACHE_TTL_MS,
  }))

  // The directory holds a TTL sweep `setInterval`. We construct it here so
  // the shutdown handler can call `directory.dispose()` when SIGTERM fires
  // and the process can exit cleanly without a dangling timer.
  const directory = createWorkspaceRelayDirectory()

  const auditAcceptSampleRate = parseAuditAcceptSampleRate({
    CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE: process.env.CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE,
    NODE_ENV: process.env.NODE_ENV,
  })

  // Token-protect /metrics in production (loopback-only otherwise).
  const metricsToken = parseMetricsToken({
    CLAXEDO_RELAY_METRICS_TOKEN: process.env.CLAXEDO_RELAY_METRICS_TOKEN,
  })
  const runtimeAccessTokenCacheTtlMs = runtimeAccessTokenCacheTtlMsFromEnv({
    CLAXEDO_RELAY_RUNTIME_ACCESS_TOKEN_CACHE_TTL_MS: process.env.CLAXEDO_RELAY_RUNTIME_ACCESS_TOKEN_CACHE_TTL_MS,
  })
  const directHttpConcurrency = directHttpConcurrencyFromEnv({
    CLAXEDO_RELAY_DIRECT_HTTP_CONCURRENCY: process.env.CLAXEDO_RELAY_DIRECT_HTTP_CONCURRENCY,
  })

  const allowedOrigins = parseAllowedOrigins(trimToUndefined(process.env.CLAXEDO_RELAY_ALLOWED_ORIGINS))

  const handler = createWorkspaceRelayBun({
    runtimeAccessKey,
    runtimeAccessTokenCacheTtlMs,
    ...(allowedOrigins ? { allowedOrigins } : {}),
    relayHostSigningKey,
    relayHostAlgorithm: "EdDSA",
    relayHostPublicKeys,
    relayHostMintKid: relayHostMaterial.current.kid,
    directory,
    auditAcceptSampleRate,
    ...(metricsToken ? { metricsToken } : {}),
    resolveTarget: (claims: RuntimeAccessTokenClaims) =>
      resolver.target(claims.workspace_id, claims.host_id),
    isRuntimeAccessTokenActive: (claims: RuntimeAccessTokenClaims) =>
      resolver.revocation({
        jti: claims.jti,
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
      }),
    resolveHostGeneration: resolver.hostGeneration,
    audit: (event: {
      action: string
      result: "allow" | "deny"
      reason?: string
      workspaceId?: string
      path: string
    }) => {
      if (event.result === "deny") {
        console.warn(
          `[workspace-relay] deny ${event.action} reason=${event.reason ?? ""} workspace=${event.workspaceId ?? ""} path=${event.path}`,
        )
      }
    },
  }, (directHttpConcurrency ? { directHttpConcurrency } : {}))

  const server = Bun.serve({
    port,
    hostname,
    // Runtime SSE heartbeats are intentionally 30s apart. Keep a bounded
    // timeout above that interval so quiet streams survive without leaving
    // unauthenticated or incomplete HTTP sockets open indefinitely.
    idleTimeout: WORKSPACE_RELAY_IDLE_TIMEOUT_SECONDS,
    fetch: handler.fetch,
    websocket: handler.websocket,
  })
  console.log(`[workspace-relay] listening on http://${hostname}:${port} resolver=${resolverUrl}`)

  // Install the SIGTERM/SIGINT drain. Default 30 s, override via
  // `CLAXEDO_RELAY_DRAIN_TIMEOUT_MS` (parsed leniently — invalid values fall
  // back to the default rather than crashing the deploy).
  const rawDrainTimeout = trimToUndefined(process.env.CLAXEDO_RELAY_DRAIN_TIMEOUT_MS)
  const parsedDrainTimeout = rawDrainTimeout ? Number(rawDrainTimeout) : NaN
  const drainTimeoutMs = Number.isFinite(parsedDrainTimeout) && parsedDrainTimeout > 0
    ? parsedDrainTimeout
    : 30_000
  // Synthetic end-to-end probe. Runs against the relay's own /health to
  // give us an independent liveness signal that does not depend on Prometheus
  // metrics. Disabled via `CLAXEDO_RELAY_SYNTHETIC_PROBE_DISABLED=1`. Cadence
  // tunable via `CLAXEDO_RELAY_SYNTHETIC_PROBE_INTERVAL_MS` (default 60_000).
  // Authenticated workspace probes belong with the Control Plane, which owns
  // Runtime Access Token issuance; this process only verifies the Relay path.
  let syntheticProbe: SyntheticProbe | undefined
  const syntheticDisabled = trimToUndefined(process.env.CLAXEDO_RELAY_SYNTHETIC_PROBE_DISABLED) === "1"
  if (!syntheticDisabled) {
    const rawProbeInterval = trimToUndefined(process.env.CLAXEDO_RELAY_SYNTHETIC_PROBE_INTERVAL_MS)
    const parsedProbeInterval = rawProbeInterval ? Number(rawProbeInterval) : NaN
    const probeIntervalMs = Number.isFinite(parsedProbeInterval) && parsedProbeInterval > 0
      ? parsedProbeInterval
      : 60_000
    syntheticProbe = startSyntheticProbe({
      relayUrl: `http://${hostname}:${port}`,
      intervalMs: probeIntervalMs,
    })
    console.log(`[workspace-relay] synthetic probe enabled (interval=${probeIntervalMs}ms)`)
  }

  installShutdownDrainHandler({
    drain: handler.drain,
    directory,
    drainTimeoutMs,
    log: (message) => console.log(message),
    stopServer: async () => {
      // Force-close any sockets the drain wait could not finish; Bun's
      // `stop(true)` triggers `close` events on tunnels, which in turn rejects
      // any straggling `pending` HTTP responses.
      // `stop()` is async in Bun: awaiting it means `stopServer` resolves only once
      // the listener and its sockets are actually closed, which is what the drain
      // and fatal handlers wait on before exiting.
      await server.stop(true)
      syntheticProbe?.stop()
    },
  })

  installFatalProcessHandlers({
    drain: handler.drain,
    directory,
    log: (message) => console.error(message),
    // Flush fatal crashes to PostHog (no-op without a key) before exiting.
    report: (error) => reportFatal(error),
    stopServer: async () => {
      // `stop()` is async in Bun: awaiting it means `stopServer` resolves only once
      // the listener and its sockets are actually closed, which is what the drain
      // and fatal handlers wait on before exiting.
      await server.stop(true)
      syntheticProbe?.stop()
    },
  })

  // Keep a marker so operators can confirm which signing key the host service must trust
  void exportPKCS8 // imported above for typing parity with potential future PEM export
}

if (import.meta.main) {
  main().catch(async (err) => {
    console.error("[workspace-relay] startup failed:", err)
    // Startup failures past env validation (which exits itself) should
    // reach the error tracker too. No-op without a key.
    await reportFatal(err)
    process.exit(1)
  })
}
