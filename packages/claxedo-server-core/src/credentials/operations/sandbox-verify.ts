import {
  isSandboxDriverID,
  sandboxDriverCredentialFields,
  type SandboxDriverID,
} from "@claxedo/sandbox-contract"
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
  auth: Record<string, string | undefined>,
  options: { fetch?: typeof fetch } = {},
): Promise<CredentialHealth> {
  const values = probeAuth(id, auth)
  if (!values) throw new CredentialVerificationError("Sandbox provider credential has an unsupported shape")
  const probe = sandboxDriverProbe(id, values)
  if (!probe) throw new CredentialVerificationError("Sandbox provider does not support verification")

  const response = await (options.fetch ?? globalThis.fetch)(probe.url, probe.init).catch(() => {
    throw new CredentialVerificationError("Sandbox provider request failed")
  })
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return "ok"
  }
  const failure = (await response.text().catch(() => "")).slice(0, 8_192).toLowerCase()
  if (probe.ok?.(response.status, failure)) return "ok"
  if (probe.inconclusive?.(response.status)) {
    throw new CredentialVerificationError("Sandbox provider could not answer for this credential")
  }
  if (
    response.status === 402 ||
    failure.includes("insufficient_quota") ||
    failure.includes("billing") ||
    failure.includes("credit balance")
  ) return "no_billing"
  if (response.status === 429) return "rate_capped"
  if (probe.rejected(response.status)) return "auth_failed"
  throw new CredentialVerificationError("Sandbox provider verification failed")
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
    throw new CredentialVerificationError("Sandbox provider does not support verification")
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
 * is still what the pre-codec encoder wrote for single-field drivers (and what
 * `credentials/migrate.ts` still writes for daytona). A stored credential that
 * predates the codec must verify, not read as an unsupported shape.
 */
function storedAuth(id: SandboxDriverID, secret: string): Record<string, string | undefined> {
  const fields = sandboxDriverCredentialFields[id]
  try {
    const parsed = JSON.parse(secret) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string | undefined>
    }
  } catch {
    // Falls through to the legacy bare reading below.
  }
  return fields.length === 1 ? { [fields[0]!.key]: secret } : {}
}

const VERIFIABLE = new Set<SandboxDriverID>(["daytona", "vercel", "cloudflare", "box", "exe"])

const REJECTED = (status: number) => status === 401 || status === 403

type SandboxDriverProbe = {
  url: string
  init: RequestInit
  /** Statuses that still prove the credential — checked before any rejection. */
  ok?: (status: number, body: string) => boolean
  /** Statuses that say nothing about the credential either way. */
  inconclusive?: (status: number) => boolean
  rejected: (status: number) => boolean
}

function sandboxDriverProbe(
  id: SandboxDriverID,
  auth: Record<string, string>,
): SandboxDriverProbe | undefined {
  const signal = () => AbortSignal.timeout(10_000)

  // Daytona: "Get current API key's details", the one route documented as
  // authenticated with the API key itself rather than a JWT
  // (https://www.daytona.io/docs/en/api-keys/). O(1) — `GET /sandbox` would
  // also answer but returns every sandbox in the account, unbounded.
  // `X-Daytona-Organization-ID` is only required for JWT auth, so it is
  // omitted here. Daytona documents no error-status semantics at all, hence
  // the deliberately narrow rejection set: anything but 401/403 falls through
  // to inconclusive rather than being guessed at.
  if (id === "daytona") {
    return {
      url: "https://app.daytona.io/api/api-keys/current",
      init: { method: "GET", signal: signal(), headers: { Authorization: `Bearer ${auth.api_key}` } },
      rejected: REJECTED,
    }
  }

  // Vercel: one documented read that proves all three stored fields
  // (https://vercel.com/docs/rest-api/reference/endpoints/projects/find-a-project-by-id-or-name).
  // `GET /v2/user` is cheaper but only proves the token, and the catalog
  // requires team and project too — a good token paired with the wrong project
  // would then verify clean and fail at first provision, which is the exact
  // failure this whole probe exists to move earlier.
  if (id === "vercel") {
    return {
      url: `https://api.vercel.com/v9/projects/${encodeURIComponent(auth.project_id!)}?teamId=${encodeURIComponent(auth.team_id!)}`,
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
    const base = workerBase(auth.worker_url!)
    if (!base) return
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

  // exe.dev: `whoami` is in the default token `cmds` allowlist and is the
  // docs' own example call (https://exe.dev/docs/https-api.md). The command
  // language is plain text in the POST body; this is the only read in the
  // default allowlist that costs nothing to run.
  if (id === "exe") {
    return {
      url: "https://exe.dev/exec",
      init: {
        method: "POST",
        signal: signal(),
        headers: {
          Authorization: `Bearer ${auth.api_token}`,
          "Content-Type": "text/plain; charset=utf-8",
        },
        body: "whoami",
      },
      // exe.dev tokens carry a signed `cmds` allowlist, and 403 is documented
      // as "this command is not in the token's list" — the token is VALID and
      // merely scoped away from the probe. Only 401 means invalid.
      inconclusive: (status) => status === 403,
      rejected: (status) => status === 401,
    }
  }

  // Modal's control plane is gRPC over HTTP/2 (`nice-grpc` against
  // api.modal.com:443) with no REST surface; `modal token set --verify` runs a
  // `ClientHello`/`WorkspaceNameLookup` RPC, which `fetch` cannot make. Docker
  // holds an image name, not a remote credential. Both are honestly
  // unverifiable rather than probed against something invented.
  return
}

/**
 * Trimmed for the same reason the model-credential path trims: a value pasted
 * out of a terminal usually arrives with surrounding whitespace, and a leading
 * space survives into the header as part of the token, so the provider is
 * handed a credential that is not the user's — a false rejection.
 */
function probeAuth(id: SandboxDriverID, auth: Record<string, string | undefined>) {
  const values = Object.fromEntries(
    sandboxDriverCredentialFields[id].flatMap((field) => {
      const value = auth[field.key]?.trim()
      return value ? [[field.key, value]] : []
    }),
  )
  if (Object.keys(values).length !== sandboxDriverCredentialFields[id].length) return
  return values
}

function workerBase(input: string) {
  try {
    const url = new URL(input)
    if (url.protocol !== "https:" && url.protocol !== "http:") return
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
  } catch {
    return
  }
}
