/**
 * The real implementations of the seams the account modules take.
 *
 * Everything electron- and node-specific lives here so the modules beside it
 * stay testable in a plain process. It is the thin end of the wedge on purpose:
 * if a decision starts creeping into this file, it belongs in one of the
 * others.
 */

import { createServer } from "node:http"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { CallbackDisposition, OAuthSeams, TokenSet } from "./oauth-flow"
import type { CredentialFile } from "./credential-store"
import { ACCOUNT_CREDENTIAL_RECORD } from "./marker"
import type { RefreshOutcome } from "./account-service"

/**
 * A loopback listener on an OS-assigned port.
 *
 * Bound to 127.0.0.1 explicitly rather than the default: the default binds every
 * interface, which would let anything on the network hand this process an
 * authorization code. Port 0 because a fixed port is one another process can
 * hold first — and RFC 8252 §7.3 expects an ephemeral one.
 */
export function loopbackListener(): OAuthSeams["listen"] {
  return async (handler) => {
    const server = createServer((request, response) => {
      const disposition: CallbackDisposition = handler(request.url ?? "/")
      response.writeHead(disposition.status, { "content-type": "text/plain; charset=utf-8" })
      response.end(disposition.body)
    })

    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (!address || typeof address === "string") {
          reject(new Error("loopback listener did not report a port"))
          return
        }
        resolve(address.port)
      })
    })

    return {
      port,
      close: () =>
        new Promise<void>((resolve) => {
          // `closeAllConnections` first: a browser keep-alive would otherwise
          // hold the socket open long past the attempt that created it.
          server.closeAllConnections?.()
          server.close(() => resolve())
        }),
    }
  }
}

/** The credential file, in Electron's per-app userData directory. */
export function credentialFile(userDataDir: string): CredentialFile {
  const path = join(userDataDir, ACCOUNT_CREDENTIAL_RECORD)
  return {
    read: () => {
      try {
        return readFileSync(path, "utf8")
      } catch {
        // Absent is the normal state before first sign-in, not an error.
        return undefined
      }
    },
    // 0600: the OS store holds the secret, but the record also names the
    // backend and expiry, and there is no reason for another user to read it.
    write: (contents) => writeFileSync(path, contents, { mode: 0o600 }),
    clear: () => rmSync(path, { force: true }),
  }
}

/** `setTimeout`, shaped as the flow's cancellable timer. */
export function nodeTimer(): OAuthSeams["setTimeout"] {
  return (fn, ms) => {
    const handle = setTimeout(fn, ms)
    // Unref'd: a pending sign-in must not keep the process alive after the user
    // has quit.
    handle.unref?.()
    return { cancel: () => clearTimeout(handle) }
  }
}

/** What a token endpoint answers with, on either grant. */
type TokenPayload = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
}

/**
 * POST to the token endpoint.
 *
 * Form-encoded with no client secret — a native app cannot keep one, which is
 * why PKCE carries the proof on the authorization-code grant, and why the
 * refresh grant sends only the client id beside the token.
 */
function postToTokenEndpoint(fetchImpl: typeof fetch, tokenUrl: string, form: Record<string, string>) {
  return fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  })
}

/**
 * A token response, as a token set.
 *
 * `fallbackRefreshToken` is what makes non-rotating servers work: a refresh
 * response that omits `refresh_token` means "keep using the one you have", and
 * dropping it there would silently downgrade the session to unrenewable — the
 * next expiry would sign the user out and nothing would explain why.
 */
function decodeTokenPayload(payload: TokenPayload, fallbackRefreshToken?: string): TokenSet | undefined {
  if (!payload.access_token) return undefined
  const refreshToken = payload.refresh_token ?? fallbackRefreshToken
  return {
    accessToken: payload.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    // Absolute, in seconds. Storing the relative `expires_in` would mean
    // every reader has to remember when it was issued.
    expiresAt: Math.floor(Date.now() / 1000) + (payload.expires_in ?? 3600),
  }
}

/** The Authorization Code exchange. */
export function tokenExchange(fetchImpl: typeof fetch = fetch): OAuthSeams["exchange"] {
  return async (input) => {
    const response = await postToTokenEndpoint(fetchImpl, input.tokenUrl, {
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    })
    if (!response.ok) throw new Error(`token exchange failed: ${response.status}`)
    const tokens = decodeTokenPayload((await response.json()) as TokenPayload)
    // Throwing, unlike the refresh grant below: this one runs inside a sign-in
    // attempt that already has a failure channel, and there is no existing
    // session whose fate depends on telling the causes apart.
    if (!tokens) throw new Error("token exchange returned no access token")
    return tokens
  }
}

export type RefreshExchange = (input: {
  tokenUrl: string
  clientId: string
  refreshToken: string
}) => Promise<RefreshOutcome>

/**
 * The Refresh Token exchange.
 *
 * Reports an OUTCOME rather than throwing, because the caller's two responses
 * are opposite and a thrown error cannot be told apart reliably enough to pick
 * between them. `revoked` deletes the user's session; `unavailable` keeps it.
 * So only the authorization server explicitly naming the grant dead —
 * `invalid_grant` per RFC 6749 §5.2, or a 401 rejecting us outright — earns
 * `revoked`. Everything else, including a bare 400, is `unavailable`: a
 * malformed request of OUR making also produces a 400, and signing the user out
 * over our own bug is the failure that cannot be walked back.
 */
export function refreshExchange(fetchImpl: typeof fetch = fetch): RefreshExchange {
  return async (input) => {
    let response: Response
    try {
      response = await postToTokenEndpoint(fetchImpl, input.tokenUrl, {
        grant_type: "refresh_token",
        client_id: input.clientId,
        refresh_token: input.refreshToken,
      })
    } catch (error) {
      // Never reached an answer — an offline laptop, DNS, a dropped TLS
      // handshake. Says nothing about the credential.
      return { ok: false, reason: "unavailable", detail: `refresh request failed: ${String(error)}` }
    }

    const body = await response.text().catch(() => "")
    const payload = parseTokenBody(body)

    if (!response.ok) {
      const revoked = payload?.error === "invalid_grant" || response.status === 401
      return revoked
        ? { ok: false, reason: "revoked", detail: `the authorization server rejected the refresh token (${response.status})` }
        : { ok: false, reason: "unavailable", detail: `refresh failed: ${response.status}` }
    }

    // A 200 naming an error is how some servers report a dead grant. A 200 that
    // simply carries no access token is the same fact in a different shape:
    // there is nothing to renew with and retrying will produce it again.
    if (payload?.error === "invalid_grant") {
      return { ok: false, reason: "revoked", detail: "the authorization server reported invalid_grant" }
    }
    const tokens = payload && decodeTokenPayload(payload, input.refreshToken)
    if (!tokens) {
      return { ok: false, reason: "unavailable", detail: "the refresh response carried no access token" }
    }
    return { ok: true, tokens }
  }
}

function parseTokenBody(body: string): TokenPayload | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    return parsed && typeof parsed === "object" ? (parsed as TokenPayload) : undefined
  } catch {
    return undefined
  }
}
