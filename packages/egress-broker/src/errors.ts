import { CREDENTIAL_BROKER_ERRORS, type CredentialBrokerErrorCode } from "@claxedo/agent-runtime-contract"

/**
 * The body of a refusal, out of the one table both this broker and the runtime
 * that classifies a failed turn read.
 *
 * An object rather than a scalar `{"error":"<code>"}`, because the readers on
 * the other end discard that — the OpenCode engine's `providerMessage` shows
 * `error.message` and nothing else — so the operator saw a bare status for the
 * one failure they could act on.
 */
export type BrokerErrorCode = CredentialBrokerErrorCode

export function brokerErrorBody(code: BrokerErrorCode) {
  return { error: { code, message: CREDENTIAL_BROKER_ERRORS[code].message } }
}
