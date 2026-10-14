import { jsonRecord, jsonString, parseJsonRecord } from "@claxedo/server-core/platform/runtime/lib/json"
import { CredentialVerificationError } from "../verification-error"
import type { CredentialHealth, CredentialVerdictEvidence } from "@claxedo/server-core/credentials/types"

const BODY_LIMIT = 8_192

/** An error type or code is an identifier; anything else is a message and stays out of the evidence. */
const ERROR_TYPE = /^[\w.:-]{1,64}$/

/** A vendor's answer with its body already taken, so the read happens inside the request's deadline. */
export type VendorReply = { status: number; headers: Headers; text: string }

export async function vendorReply(response: Response): Promise<VendorReply> {
  return { status: response.status, headers: response.headers, text: (await response.text().catch(() => "")).slice(0, BODY_LIMIT) }
}

export type VendorAnswer = {
  evidence: CredentialVerdictEvidence
  /** The vendor API's own error document; absent when the body is not JSON — an edge's challenge page, a gateway's text. */
  api?: Record<string, unknown>
  contentType: string | null
}

export type VendorRefusal = { health: Exclude<CredentialHealth, "ok">; evidence: CredentialVerdictEvidence }

export function readVendorAnswer(reply: VendorReply): VendorAnswer {
  const api = parseJsonRecord(reply.text)
  const type = api ? vendorErrorType(api) : undefined
  const retryAfterSeconds = retryAfter(reply.headers.get("retry-after"))
  return {
    evidence: {
      status: reply.status,
      ...(type ? { type } : {}),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
    ...(api ? { api } : {}),
    contentType: reply.headers.get("content-type"),
  }
}

/**
 * What a vendor's non-ok answer says about the credential.
 *
 * Only the vendor API's own answer is a verdict. chatgpt.com answers a
 * Worker's request with Cloudflare's challenge page — a 403 with an HTML body
 * and no API error — and that is the edge refusing the client, not the vendor
 * refusing the login, so every non-JSON answer other than a throttle decides
 * nothing and is thrown as inconclusive. A 429 is read whatever its body: the
 * vendor took the credential and asked for time, and that verdict never ends
 * an account.
 */
export function vendorRefusal(reply: VendorReply): VendorRefusal {
  const answer = readVendorAnswer(reply)
  const { evidence } = answer
  const failure = answer.api ? reply.text.toLowerCase() : ""
  // OpenAI says an unfunded key has run out of quota with a 429, so the
  // billing words are read before the status is.
  if (
    answer.api && (
      reply.status === 402 ||
      failure.includes("insufficient_quota") ||
      failure.includes("usage_not_included") ||
      failure.includes("billing") ||
      failure.includes("credit balance")
    )
  ) return { health: "no_billing", evidence }
  if (reply.status === 429) return { health: "rate_capped", evidence }
  if (!answer.api) {
    throw new CredentialVerificationError(
      "credential_verification_failed",
      `Credential provider answered ${reply.status} with ${answer.contentType ?? "no content type"} rather than an API error`,
    )
  }
  if (failure.includes("token_expired") || failure.includes("expired_token")) return { health: "expired", evidence }
  if (reply.status === 401 || reply.status === 403) return { health: "auth_failed", evidence }
  throw new CredentialVerificationError(
    "credential_verification_failed",
    `Credential provider answered ${reply.status}${evidence.type ? ` ${evidence.type}` : ""}`,
  )
}

/**
 * Anthropic names it `error.type`, OpenAI `error.type` or `error.code`, an
 * OAuth token endpoint `error`, the ChatGPT backend `detail.code` when it has
 * one and a bare message otherwise.
 */
function vendorErrorType(api: Record<string, unknown>): string | undefined {
  const error = jsonRecord(api.error)
  return [error?.type, error?.code, api.error, jsonRecord(api.detail)?.code, api.code]
    .map(jsonString)
    .find((item) => item !== undefined && ERROR_TYPE.test(item))
}

function retryAfter(header: string | null): number | undefined {
  if (header === null) return undefined
  const seconds = Number.parseInt(header, 10)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}
