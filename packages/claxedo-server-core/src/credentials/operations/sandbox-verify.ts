import {
  cloudflareWorkerBaseUrl,
  isSandboxDriverID,
  sandboxDriverCredentialFields,
  type SandboxDriverID,
} from "@claxedo/sandbox-contract"
import { jsonRecord } from "@claxedo/server-core/platform/runtime/lib/json"
import { CredentialVerificationError } from "../verification-error"
import type { CredentialHealth } from "@claxedo/server-core/credentials/types"

/**
 * Probe a sandbox provider's credential against that provider.
 *
 * Every probe below is the vendor's own documented cheapest authenticated
 * READ: it creates nothing, mutates nothing, and bills nothing. A provider
 * with no such documented read is reported as unverifiable rather than probed
 * against a guessed endpoint — a wrong probe that 404s would condemn a working
 * key, which is worse than admitting we cannot check.
 *
 * Never returns a verdict for an unreachable provider. A failed request throws
 * `CredentialVerificationError` so callers render "couldn't check", the same
 * discipline `verifyCredential` follows for model providers.
 */
export async function verifySandboxDriverAuth(
  id: SandboxDriverID,
  // A decoded credential blob: `probeAuth` establishes which fields are usable
  // strings, so the parameter does not have to promise what the blob cannot.
  auth: Record<string, unknown>,
  options: { fetch?: typeof fetch } = {},
): Promise<CredentialHealth> {
  const values = probeAuth(id, auth)
  if (!values) throw new CredentialVerificationError("credential_shape_invalid", "Sandbox provider credential has an unsupported shape")
  const probe = sandboxDriverProbe(id, values)
  if (!probe) throw new CredentialVerificationError("credential_verification_unsupported", "Sandbox provider does not support verification")

  const response = await (options.fetch ?? globalThis.fetch)(probe.url, { ...probe.init, redirect: "error" }).catch(() => {
    throw new CredentialVerificationError("credential_provider_unavailable", "Sandbox provider request failed")
  })
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    throw new CredentialVerificationError("credential_redirect_denied", "Sandbox provider redirects are not allowed")
  }
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return "ok"
  }
  const failure = (await response.text().catch(() => "")).slice(0, 8_192).toLowerCase()
  if (probe.ok?.(response.status, failure)) return "ok"
  if (
    response.status === 402 ||
    failure.includes("insufficient_quota") ||
    failure.includes("billing") ||
    failure.includes("credit balance")
  ) return "no_billing"
  if (response.status === 429) return "rate_capped"
  if (probe.rejected(response.status)) return "auth_failed"
  throw new CredentialVerificationError("credential_verification_failed", "Sandbox provider verification failed")
}

/**
 * Verify a credential as it is STORED — one opaque string per credential,
 * written by the codec in `routes/sandbox-driver-routes.ts`. Kept next to the
 * probes so `verifyCredential` can route the `sandbox_driver` kind without
 * knowing the encoding.
 */
export async function verifySandboxDriverCredential(
  providerId: string,
  secret: string,
  options: { fetch?: typeof fetch } = {},
): Promise<CredentialHealth> {
  if (!isSandboxDriverID(providerId)) {
    throw new CredentialVerificationError("credential_verification_unsupported", "Sandbox provider does not support verification")
  }
  return verifySandboxDriverAuth(providerId, storedAuth(providerId, secret), options)
}

/** Whether this provider can be checked at all, without spending a request. */
export function sandboxDriverVerifiable(id: SandboxDriverID) {
  return VERIFIABLE.has(id)
}

/**
 * Mirrors `parseManagedAuth`'s tolerance in
 * `sandbox-manager-adapters/driver-auth.ts`: always JSON now, but a bare string
 * is still what the pre-codec encoder wrote for single-field drivers. A stored
 * credential that predates the codec must verify, not read as an unsupported
 * shape.
 */
function storedAuth(id: SandboxDriverID, secret: string): Record<string, unknown> {
  const fields = sandboxDriverCredentialFields[id]
  try {
    const parsed = jsonRecord(JSON.parse(secret))
    if (parsed) return parsed
  } catch {
    // Falls through to the legacy bare reading below.
  }
  return fields.length === 1 ? { [fields[0].key]: secret } : {}
}

const VERIFIABLE = new Set<SandboxDriverID>(["vercel", "cloudflare", "box"])

const REJECTED = (status: number) => status === 401 || status === 403

type SandboxDriverProbe = {
  url: string
  init: RequestInit
  /** Statuses that still prove the credential — checked before any rejection. */
  ok?: (status: number, body: string) => boolean
  rejected: (status: number) => boolean
}

function sandboxDriverProbe(id: SandboxDriverID, auth: Record<string, string>): SandboxDriverProbe | undefined {
  const signal = () => AbortSignal.timeout(10_000)

  // Vercel: one documented read that proves all three stored fields
  // (https://vercel.com/docs/rest-api/reference/endpoints/projects/find-a-project-by-id-or-name).
  // `GET /v2/user` is cheaper but only proves the token, and the catalog
  // requires team and project too — a good token paired with the wrong project
  // would then verify clean and fail at first provision, which is the exact
  // failure this whole probe exists to move earlier.
  if (id === "vercel") {
    return {
      url: `https://api.vercel.com/v9/projects/${encodeURIComponent(auth.project_id)}?teamId=${encodeURIComponent(auth.team_id)}`,
      init: { method: "GET", signal: signal(), headers: { Authorization: `Bearer ${auth.access_token}` } },
      // 404 is a verdict, not a miss: the token authenticated and the project
      // it names is unreachable, so this credential set cannot launch anything.
      rejected: (status) => REJECTED(status) || status === 404,
    }
  }

  // Cloudflare: the credential is the user's OWN Worker's `API_TOKEN` secret,
  // not a Cloudflare account API token — the driver holds no account
  // credentials by design (drivers/cloudflare.ts:265-268). So
  // `api.cloudflare.com/client/v4/user/tokens/verify`, the obvious candidate,
  // would check a credential we do not have. The pair is only meaningful to
  // the deployed Worker, and its `GET /sandboxes` is the only non-mutating
  // route behind the same admin gate as the control actions.
  if (id === "cloudflare") {
    let base: string
    try { base = cloudflareWorkerBaseUrl(auth.worker_url) } catch {
      throw new CredentialVerificationError("credential_endpoint_invalid", "Cloudflare Worker URL requires a valid HTTPS endpoint without credentials, query or fragment")
    }
    return {
      url: `${base}/sandboxes`,
      init: { method: "GET", signal: signal(), headers: { Authorization: `Bearer ${auth.api_token}` } },
      // The Worker answers 501 when no R2 bucket is bound, and that reply is
      // produced after the gate — reaching it proves the token. Rejecting the
      // pair over an unrelated optional binding would be a false verdict.
      ok: (status) => status === 501,
      rejected: REJECTED,
    }
  }

  // Box by ASCII: "Get current Box user"
  // (https://docs.ascii.dev/box/api/reference/account/get-current-box-user.md).
  // O(1) and returns an identity, unlike `GET /boxes` which enumerates.
  if (id === "box") {
    return {
      url: "https://ascii.dev/api/box/v1/me",
      init: { method: "GET", signal: signal(), headers: { Authorization: `Bearer ${auth.api_key}` } },
      rejected: REJECTED,
    }
  }

  // Modal's control plane is gRPC over HTTP/2 (`nice-grpc` against
  // api.modal.com:443) with no REST surface; `modal token set --verify` runs a
  // `ClientHello`/`WorkspaceNameLookup` RPC, which `fetch` cannot make. Docker
  // holds an image name, not a remote credential. Both are honestly
  // unverifiable rather than probed against something invented.
  return undefined
}

/**
 * Trimmed for the same reason the model-credential path trims: a value pasted
 * out of a terminal usually arrives with surrounding whitespace, and a leading
 * space survives into the header as part of the token, so the provider is
 * handed a credential that is not the user's — a false rejection.
 */
function probeAuth(id: SandboxDriverID, auth: Record<string, unknown>): Record<string, string> | undefined {
  const values: Record<string, string> = {}
  for (const field of sandboxDriverCredentialFields[id]) {
    const raw = auth[field.key]
    const value = typeof raw === "string" ? raw.trim() : ""
    if (value) values[field.key] = value
  }
  return Object.keys(values).length === sandboxDriverCredentialFields[id].length ? values : undefined
}
