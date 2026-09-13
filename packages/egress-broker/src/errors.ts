/**
 * Every refusal the broker answers with, and the one line each says.
 *
 * The body is an object because a scalar `{"error":"<code>"}` is discarded by
 * the readers on the other end — the OpenCode engine's `providerMessage` shows
 * `error.message` and nothing else — so the operator saw a bare status for the
 * one failure they could act on. The code is the machine half: 403 stands both
 * for a credential the broker will not serve and for a route the binding does
 * not allow, and reading that status alone tells the operator to replace a
 * working account for a request the harness should never have made.
 */
export const BROKER_ERRORS = {
  binding_route_required: "The credential broker serves binding paths only",
  runtime_token_required: "The request carried no runtime token, or two that disagree",
  runtime_token_invalid: "The runtime token could not be verified",
  binding_not_permitted: "This runtime token does not name that binding",
  binding_unavailable: "The binding names no account this runtime can spend",
  credential_unavailable: "The account behind this binding has no readable value",
  binding_destination_invalid: "The binding's destination is not a usable vendor origin",
  binding_injection_invalid: "The binding names a header the broker cannot set",
  request_outside_policy: "The request is outside the routes this binding allows",
  upstream_unavailable: "The vendor could not be reached",
  upstream_redirect_refused: "The vendor answered with a redirect, which the broker does not follow",
  broker_authority_unavailable: "The credential authority could not be reached",
} as const

export type BrokerErrorCode = keyof typeof BROKER_ERRORS

export function brokerErrorBody(code: BrokerErrorCode) {
  return { error: { code, message: BROKER_ERRORS[code] } }
}
