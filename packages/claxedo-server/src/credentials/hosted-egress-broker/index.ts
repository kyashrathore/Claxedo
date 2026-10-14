import { bindingBaseUrl, brokerErrorBody, createEgressBroker, presentedRuntimeToken, type RuntimeIdentity } from "@claxedo/egress-broker"
import type { CredentialBrokerErrorCode, ProviderBindingSource } from "@claxedo/agent-runtime-contract"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { ControlPlaneTelemetry } from "@claxedo/server-core/platform/telemetry/ports"
import { destinationAuthMode } from "@claxedo/server-core/credentials/built-in-destinations"
import type { HarnessCredentialBroker } from "@claxedo/server-core/credentials/native-delivery-plan"
import type { ControlPlaneCredentials } from "../../authority/services"
import { createFixedWindowConnectionRateLimiter } from "../../platform/auth/rate-limit"
import { requestClientKeyFromHeaders, type RouteGuardExemption } from "../../platform/auth/request-guard"
import { hostedBindingAuthority, type HostedBrokerCredentialRead } from "./authority"
import { brokerBindingId, mintBrokerPlaceholder, verifyBrokerPlaceholder, type HostedBrokerClaims } from "./placeholder"

export { EGRESS_BROKER_PASS_AUDIENCE, brokerBindingId, mintBrokerPlaceholder, verifyBrokerPlaceholder, type HostedBrokerClaims } from "./placeholder"

/**
 * A projection that says the account is deliverable without minting anything:
 * a draft's refusal is decided from the projection's shape alone, and a pass
 * minted for an answer nobody delivers would be a live capability held for
 * nothing. Never applied to a runtime.
 */
export const DRAFT_PLACEHOLDER = "draft"

/**
 * Upstream exchanges one sandbox may hold at once. Claude Code runs a handful
 * of streams in parallel for subagents; past this the sandbox's own requests
 * queue, and no other tenant's do.
 */
export const RUNTIME_UPSTREAM_LANES = 16

/** Runtimes with a broker of their own held at once in one isolate; the least recently used is dropped past this. */
const HELD_RUNTIMES = 256

/** How long one `broker_refused` stands for every refusal of its code in this isolate. */
const REFUSAL_SAMPLE_MS = 60_000

/**
 * `broker_refused` for the first refusal of each code per minute per isolate,
 * carrying how many refusals of that code the previous event stood for. A
 * flood of unverifiable requests is refused one per request and must not be
 * reported one per request; the count keeps its size, the sample its shape.
 * No request detail travels: the code and status say what the broker said.
 */
function brokerRefusalSampler(telemetry: ControlPlaneTelemetry | undefined, now: () => number) {
  const windows = new Map<string, { sentAt: number; suppressed: number }>()
  return (refusal: { code: CredentialBrokerErrorCode; status: number }) => {
    if (!telemetry) return
    const at = now()
    const window = windows.get(refusal.code)
    if (window && at - window.sentAt < REFUSAL_SAMPLE_MS) {
      window.suppressed += 1
      return
    }
    windows.set(refusal.code, { sentAt: at, suppressed: 0 })
    telemetry.capture("system", "broker_refused", { code: refusal.code, status: refusal.status, suppressed: window?.suppressed ?? 0 })
  }
}

/** Verified placeholders held by their text, so a pass costs one signature check per isolate rather than one per request. */
const HELD_PLACEHOLDERS = 1024

/**
 * Requests per client address and minute that present no verifiable
 * placeholder. A verified request never counts: it is bounded by its own
 * runtime's lanes instead.
 */
const UNVERIFIED_REQUESTS_PER_MINUTE = 60

/** The sandbox a placeholder is minted for, as the lease store reports it once the sandbox is ready. */
export type BrokerLease = { epoch: number; hostId: string }

export type HostedEgressBroker = {
  /** Mounted at `/bindings/*` on the control plane's public origin. */
  handler: (request: Request) => Promise<Response>
  /** The account binder for one workspace's deliveries; without a lease it projects draft placeholders. */
  binder(input: { orgId: string; workspaceId: string; lease?: BrokerLease }): HarnessCredentialBroker
}

/**
 * The broker's own refusals stand in for the default guard: a request with no
 * verifiable placeholder is counted per client address and turned away before
 * any upstream work, a verified one is bounded by its runtime's own lanes, and
 * the vendor's own limits bound a turn's body, which the broker streams rather
 * than buffers.
 */
export const HOSTED_EGRESS_BROKER_GUARD_EXEMPTION: RouteGuardExemption = {
  prefix: "/bindings",
  bodyCap: true,
  rateLimit: true,
  reason: "A model turn's request body is routinely past 1 MiB and must stream to the vendor unbuffered; sandboxes behind one egress address would share one per-client budget.",
  enforcedBy: "src/credentials/hosted-egress-broker/index.ts (per-client budget for unverified requests, per-runtime upstream lanes for verified ones)",
}

/** A bounded map that forgets its least recently used entry. */
function recent<K, V>(capacity: number) {
  const held = new Map<K, V>()
  return {
    get(key: K): V | undefined {
      const value = held.get(key)
      if (value !== undefined) {
        held.delete(key)
        held.set(key, value)
      }
      return value
    },
    set(key: K, value: V) {
      held.delete(key)
      held.set(key, value)
      if (held.size > capacity) held.delete(held.keys().next().value!)
    },
  }
}

/**
 * The hosted plane's egress broker: `@claxedo/egress-broker` over the
 * organization credential stores, with the plane's runtime signing key
 * minting and verifying the placeholders as sandbox passes.
 *
 * Every runtime gets a broker of its own, so one sandbox's streams fill its
 * own lanes and nobody else's; the authority behind them is shared. A request
 * is verified before it is routed to one, and the verdict is held for the
 * pass's life.
 *
 * It serves the drivers whose sandboxes have no provider edge. A driver with
 * one is never pointed here: its deliveries stay edge secrets, and this
 * broker is not on their request path.
 */
export function createHostedEgressBroker(input: {
  credentials: (orgId: string) => ControlPlaneCredentials
  read: (orgId: string) => HostedBrokerCredentialRead
  sandboxManager: Pick<SandboxManager, "target">
  env: Record<string, string | undefined>
  /** The public origin sandboxes reach the plane at; a binding's base URL is under it. */
  origin: string
  fetch?: typeof fetch
  now?: () => number
  /** Ceiling on reaching a vendor's response headers, and on a runtime's wait for one of its lanes. */
  upstreamTimeoutMs?: number
  telemetry?: ControlPlaneTelemetry
}): HostedEgressBroker {
  const now = input.now ?? Date.now
  const onRefusal = brokerRefusalSampler(input.telemetry, now)
  const readers = new Map<string, HostedBrokerCredentialRead>()
  const read = (orgId: string) => {
    let reader = readers.get(orgId)
    if (!reader) {
      reader = input.read(orgId)
      readers.set(orgId, reader)
    }
    return reader
  }
  const authority = hostedBindingAuthority({ credentials: input.credentials, read, sandboxManager: input.sandboxManager, ...(input.fetch ? { fetch: input.fetch } : {}), now })
  const verified = recent<string, HostedBrokerClaims>(HELD_PLACEHOLDERS)
  const verify = async (token: string): Promise<HostedBrokerClaims | undefined> => {
    const held = verified.get(token)
    if (held && held.exp * 1_000 > now()) return held
    const claims = await verifyBrokerPlaceholder(token, input.env, { now })
    if (claims) verified.set(token, claims)
    return claims
  }
  const brokers = recent<string, (request: Request) => Promise<Response>>(HELD_RUNTIMES)
  const brokerFor = (claims: HostedBrokerClaims) => {
    const key = `${claims.orgId}\n${claims.workspaceId}\n${claims.leaseId}\n${claims.leaseGeneration}\n${claims.runtimeId}`
    let broker = brokers.get(key)
    if (!broker) {
      broker = createEgressBroker<HostedBrokerClaims>({
        authority,
        verifyToken: verify,
        maxConcurrentUpstream: RUNTIME_UPSTREAM_LANES,
        onRefusal,
        ...(input.fetch ? { fetch: input.fetch } : {}),
        ...(input.upstreamTimeoutMs ? { upstreamTimeoutMs: input.upstreamTimeoutMs } : {}),
      })
      brokers.set(key, broker)
    }
    return broker
  }
  // Answers every request no runtime is known for, which is a refusal in the broker's own words.
  const refusing = createEgressBroker<HostedBrokerClaims>({ authority, verifyToken: verify, onRefusal, ...(input.fetch ? { fetch: input.fetch } : {}) })
  const unverified = createFixedWindowConnectionRateLimiter({ limit: UNVERIFIED_REQUESTS_PER_MINUTE, windowMs: 60_000, now })
  const handler = async (request: Request): Promise<Response> => {
    const token = presentedRuntimeToken(request.headers)
    const claims = token ? await verify(token) : undefined
    if (claims) return brokerFor(claims)(request)
    const budget = unverified.check({ userId: requestClientKeyFromHeaders(request.headers), workspaceId: "egress-broker" })
    if (!budget.allowed) {
      onRefusal({ code: "runtime_token_rate_limited", status: 429 })
      return Response.json(brokerErrorBody("runtime_token_rate_limited"), {
        status: 429,
        headers: { "retry-after": String(Math.max(1, Math.ceil((budget.retryAfterMs ?? 60_000) / 1_000))) },
      })
    }
    return refusing(request)
  }
  return {
    handler,
    binder: ({ orgId, workspaceId, lease }) => ({
      async bind(credential, destination): Promise<ProviderBindingSource> {
        const userId = credential.owner ?? `org:${orgId}`
        const id = brokerBindingId({ userId, orgId, workspaceId, providerId: credential.provider_id })
        const route = {
          baseUrl: bindingBaseUrl(input.origin, id),
          authMode: destinationAuthMode(destination),
          ...(destination.apiPath ? { apiPath: destination.apiPath } : {}),
          account: { credentialId: credential.id, providerId: credential.provider_id, ...(credential.label ? { label: credential.label } : {}) },
        }
        if (!lease) return { ...route, placeholder: DRAFT_PLACEHOLDER }
        const identity: RuntimeIdentity = { userId, orgId, workspaceId, leaseId: `sandbox:${workspaceId}`, leaseGeneration: lease.epoch, runtimeId: lease.hostId }
        const { placeholder, expiresAt } = await mintBrokerPlaceholder({ identity, bindingId: id, credentialId: credential.id }, input.env, { now })
        return { ...route, placeholder, expiresAt }
      },
    }),
  }
}
