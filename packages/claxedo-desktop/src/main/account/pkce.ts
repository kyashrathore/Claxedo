/**
 * PKCE for the desktop's Authorization Code flow.
 *
 * A native app cannot keep a client secret — the binary ships to the user — so
 * the authorization code is the only thing standing between an attacker and an
 * account. PKCE binds that code to the process that requested it: the
 * authorization server will only exchange it for whoever can produce the
 * verifier whose hash it saw at authorize time.
 *
 * Two decisions here are load-bearing:
 *
 *   - **S256 only.** The spec also allows `plain`, where the challenge IS the
 *     verifier. That protects nothing: anything that can steal the code from a
 *     loopback redirect can read the challenge from the same URL. A `plain`
 *     branch would exist solely to be selected by mistake, so there isn't one.
 *   - **The system browser, not an embedded window.** An in-app BrowserWindow
 *     showing the identity provider's login is a window we control, rendering a
 *     password field — indistinguishable from a phishing page and unable to use
 *     the user's existing session, passkeys, or password manager.
 *
 * Pure: no electron, no network. `oauth-flow.ts` supplies the seams.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/** RFC 7636 §4.1: 43-128 characters from the unreserved set. */
const VERIFIER_BYTES = 32

export type PkcePair = {
  verifier: string
  challenge: string
  method: "S256"
}

function base64Url(input: Buffer) {
  return input.toString("base64url")
}

export function createPkcePair(random: (size: number) => Buffer = randomBytes): PkcePair {
  const verifier = base64Url(random(VERIFIER_BYTES))
  return {
    verifier,
    challenge: base64Url(createHash("sha256").update(verifier).digest()),
    method: "S256",
  }
}

/**
 * The `state` parameter: a per-attempt nonce, compared on the way back.
 *
 * Separate from the PKCE verifier on purpose. They defend different things —
 * PKCE proves the code came back to the process that asked for it, `state`
 * proves the CALLBACK belongs to an attempt we started. Without it, any
 * process on the machine that can reach the loopback listener can hand it a
 * code of its own choosing and log the user into an attacker's account.
 */
export function createState(random: (size: number) => Buffer = randomBytes) {
  return base64Url(random(VERIFIER_BYTES))
}

/**
 * Constant-time comparison for the returned `state`.
 *
 * Not because a timing attack on a loopback listener is likely, but because the
 * alternative costs nothing and the cheap version is the one that gets copied
 * into a place where it matters.
 */
export function statesMatch(expected: string, received: string) {
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export type AuthorizeRequest = {
  authorizeUrl: string
  clientId: string
  redirectUri: string
  scope: string
  pkce: PkcePair
  state: string
}

export function buildAuthorizeUrl(input: AuthorizeRequest) {
  const url = new URL(input.authorizeUrl)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("scope", input.scope)
  url.searchParams.set("state", input.state)
  url.searchParams.set("code_challenge", input.pkce.challenge)
  url.searchParams.set("code_challenge_method", input.pkce.method)
  return url.toString()
}

export type CallbackResult =
  | { ok: true; code: string }
  | { ok: false; reason: string }

/**
 * Read the authorization server's redirect back to our loopback listener.
 *
 * Every rejection here is a security decision, so each is distinct rather than
 * one generic failure: an unexpected `state` and a missing `code` mean very
 * different things when they show up in a log.
 */
export function readCallback(input: { url: string; expectedState: string; redirectPath: string }): CallbackResult {
  let parsed: URL
  try {
    parsed = new URL(input.url, "http://127.0.0.1")
  } catch {
    return { ok: false, reason: "callback url could not be parsed" }
  }
  if (parsed.pathname !== input.redirectPath) return { ok: false, reason: `unexpected callback path ${parsed.pathname}` }

  const error = parsed.searchParams.get("error")
  if (error) return { ok: false, reason: `authorization server returned ${error}` }

  const state = parsed.searchParams.get("state")
  if (!state) return { ok: false, reason: "callback carried no state" }
  if (!statesMatch(input.expectedState, state)) return { ok: false, reason: "callback state did not match" }

  const code = parsed.searchParams.get("code")
  if (!code) return { ok: false, reason: "callback carried no code" }
  return { ok: true, code }
}

/**
 * The loopback redirect URI.
 *
 * `127.0.0.1`, not `localhost`: the literal address cannot be redirected by a
 * hosts-file entry or a resolver, and RFC 8252 §7.3 recommends it for exactly
 * that reason. The port is whatever the OS assigned, so it is supplied rather
 * than fixed — a fixed port is one another process can hold first.
 */
export function loopbackRedirectUri(port: number, redirectPath: string) {
  return `http://127.0.0.1:${port}${redirectPath}`
}
