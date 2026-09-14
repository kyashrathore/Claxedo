/**
 * What a vendor's login document says about the account it belongs to.
 *
 * Pure parsing over a JWT's claims, and here rather than beside either reader:
 * the credential authority asks it to name a stored account, and the Codex
 * harness asks it of the auth file the CLI wrote. Two copies drifted on which
 * claim they would accept, and an account id read one way and written the other
 * spends one subscription's token against another's plan.
 */

import { asRecord, asText } from "./values"

/**
 * Declared rather than taken from a lib: both are globals in every runtime this
 * package ships to, and a consumer typechecking this source with a narrower
 * `lib` than ours must not fail on them. A published contract cannot require
 * its consumers' compiler flags to match its own.
 */
declare const atob: (data: string) => string
declare const TextDecoder: { new (): { decode(input: Uint8Array): string } }

/**
 * A JWT's payload as a record, or nothing when the value is not one.
 *
 * Decoded without `Buffer`, which this package cannot reach in a browser
 * bundle, and through `TextDecoder` rather than `atob`'s own output, because a
 * claim holding a non-ASCII name is UTF-8 and `atob` yields latin1 code units.
 */
export function jwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  const payload = token?.split(".")[1]
  if (!payload) return undefined
  const base64 = payload.replaceAll("-", "+").replaceAll("_", "/")
  try {
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return asRecord(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    return undefined
  }
}

/** The tokens a login document can carry, in the order a claim reader tries them. */
function tokensOf(input: Record<string, unknown> | undefined): Array<string | undefined> {
  const tokens = asRecord(input?.tokens)
  return [
    asText(input?.id_token) ?? asText(tokens?.id_token),
    asText(input?.access_token) ?? asText(input?.access) ?? asText(tokens?.access_token),
  ]
}

/**
 * The account's email address out of a login document's claims.
 *
 * Which claim holds it depends on the issuer and on which token is present: a
 * ChatGPT `id_token` carries `email`, an access token often carries only
 * `preferred_username`, and the `https://api.openai.com/auth` namespace keeps
 * its own copy. The `@` test is what separates an address from a bare
 * username, which `preferred_username` is free to be.
 *
 * A secret that is not a JWT names no account — never an error, because a
 * credential without an email is ordinary.
 */
export function emailFromClaims(input: Record<string, unknown> | undefined): string | undefined {
  return tokensOf(input).map(emailFromJwt).find((value) => value !== undefined)
}

function emailFromJwt(token: string | undefined): string | undefined {
  const claims = jwtClaims(token)
  const openai = asRecord(claims?.["https://api.openai.com/auth"])
  return [claims?.email, claims?.preferred_username, openai?.email]
    .map(asText)
    .find((value) => value !== undefined && value.includes("@"))
}

/**
 * The ChatGPT account a login document names.
 *
 * This is what tells the Codex backend which plan a token spends, and a login
 * often carries it only inside the `id_token`. An organization list is the last
 * resort: a login that names no account id still belongs to the first
 * organization its claims list.
 */
export function accountIdFromClaims(input: Record<string, unknown> | undefined): string | undefined {
  return tokensOf(input).map(accountIdFromJwt).find((value) => value !== undefined)
}

export function accountIdFromJwt(token: string | undefined): string | undefined {
  const claims = jwtClaims(token)
  if (!claims) return undefined
  const openai = asRecord(claims["https://api.openai.com/auth"])
  const named = asText(claims.chatgpt_account_id) ?? asText(openai?.chatgpt_account_id)
  if (named) return named
  const organizations = claims.organizations
  return Array.isArray(organizations) ? asText(asRecord(organizations[0])?.id) : undefined
}
