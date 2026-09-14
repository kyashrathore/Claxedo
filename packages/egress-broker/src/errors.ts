import { CREDENTIAL_BROKER_ERRORS, type CredentialBrokerErrorCode } from "@claxedo/agent-runtime-contract"

/**
 * An object rather than a scalar `{"error":"<code>"}`, because the readers on
 * the other end discard that — the OpenCode engine's `providerMessage` shows
 * `error.message` and nothing else — so the operator saw a bare status for the
 * one failure they could act on.
 */
export function brokerErrorBody(code: CredentialBrokerErrorCode) {
  return { error: { code, message: CREDENTIAL_BROKER_ERRORS[code].message } }
}
