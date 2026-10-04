import { isRecord } from "@claxedo/helpers/guards"

/**
 * Every refusal Claxedo's credential broker answers with: the one line each
 * says, and which side of the turn it blames.
 *
 * One table because two readers act on these codes — the broker writes them,
 * and the runtime that classifies a failed turn decides from them what to tell
 * the operator. A second hand-kept copy could only disagree, and disagreeing
 * here means telling someone to replace a working account for a request their
 * harness should never have made.
 *
 * `fault` is that decision. The HTTP status cannot stand in for it: 403 is the
 * answer both for a credential the broker will not serve and for a route the
 * binding does not allow.
 */
export const CREDENTIAL_BROKER_ERRORS = {
  binding_route_required: {
    fault: "harness",
    message: "The credential broker serves binding paths only",
  },
  runtime_token_required: {
    fault: "harness",
    message: "The request carried no runtime token, or two that disagree",
  },
  runtime_token_invalid: {
    fault: "credential",
    message: "The runtime token could not be verified",
  },
  binding_not_permitted: {
    fault: "harness",
    message: "This runtime token does not name that binding",
  },
  binding_unavailable: {
    fault: "credential",
    message: "The binding names no account this runtime can spend",
  },
  credential_unavailable: {
    fault: "credential",
    message: "The account behind this binding has no readable value",
  },
  binding_destination_invalid: {
    fault: "harness",
    message: "The binding's destination is not a usable vendor origin",
  },
  binding_injection_invalid: {
    fault: "harness",
    message: "The binding names a header the broker cannot set",
  },
  request_outside_policy: {
    fault: "harness",
    message: "The request is outside the routes this binding allows",
  },
  upstream_unavailable: {
    fault: "model",
    message: "The vendor could not be reached",
  },
  upstream_redirect_refused: {
    fault: "model",
    message: "The vendor answered with a redirect, which the broker does not follow",
  },
  broker_authority_unavailable: {
    fault: "harness",
    message: "The credential authority could not be reached",
  },
  /** Answered by the mounts in front of the broker, in the broker's vocabulary. */
  loopback_required: {
    fault: "harness",
    message: "The credential broker answers loopback callers only",
  },
} as const satisfies Record<string, { fault: "credential" | "harness" | "model"; message: string }>

export type CredentialBrokerErrorCode = keyof typeof CREDENTIAL_BROKER_ERRORS

/**
 * The code a message carries.
 *
 * The JSON body a harness echoed first: one that retried names its earlier
 * failure in its own prose, and the verdict belongs to the response it gave up
 * on. The bare code in that prose is the fallback, for a harness that
 * summarises the body rather than quoting it.
 */
export function credentialBrokerErrorCode(message: string): CredentialBrokerErrorCode | undefined {
  const inBody = codeFromBody(message)
  if (inBody) return inBody
  const inProse = codeInProse.exec(message)?.[1]
  return inProse && isCredentialBrokerErrorCode(inProse) ? inProse : undefined
}

const codeInProse = new RegExp(`\\b(${Object.keys(CREDENTIAL_BROKER_ERRORS).join("|")})\\b`)

function codeFromBody(message: string): CredentialBrokerErrorCode | undefined {
  const start = message.indexOf("{")
  const end = message.lastIndexOf("}")
  if (start === -1 || end <= start) return undefined
  try {
    const body: unknown = JSON.parse(message.slice(start, end + 1))
    const error = isRecord(body) ? body.error : undefined
    const code = typeof error === "string" ? error : isRecord(error) ? error.code : undefined
    return typeof code === "string" && isCredentialBrokerErrorCode(code) ? code : undefined
  } catch {
    return undefined
  }
}

export function isCredentialBrokerErrorCode(value: string): value is CredentialBrokerErrorCode {
  return Object.hasOwn(CREDENTIAL_BROKER_ERRORS, value)
}
