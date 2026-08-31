/**
 * The real implementations of the seams the account modules take.
 *
 * Everything electron- and node-specific lives here so the modules beside it
 * stay testable in a plain process. It is the thin end of the wedge on purpose:
 * if a decision starts creeping into this file, it belongs in one of the
 * others.
 */

import { createServer } from "node:http"
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { basename, join } from "node:path"
import type { CallbackDisposition, OAuthSeams, TokenSet } from "./oauth-flow"
import type { CredentialFile } from "./credential-store"
import { ACCOUNT_CREDENTIAL_RECORD } from "./marker"
import type { RefreshOutcome } from "./desktop-native-auth"

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
      // OAuth redirects are one-shot. Explicitly close the client connection
      // after the response so a browser (and Bun's Windows fetch pool) cannot
      // leave an idle keep-alive socket owned by a completed sign-in attempt.
      response.writeHead(disposition.status, {
        "content-type": "text/plain; charset=utf-8",
        connection: "close",
      })
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
          // Stop accepting first, then evict both idle keep-alives and any
          // remaining active socket. Closing connections before `close()`
          // leaves a race in which a new connection can arrive between them.
          server.close(() => resolve())
          server.closeIdleConnections?.()
          server.closeAllConnections?.()
        }),
    }
  }
}

/** The credential file, in Electron's per-app userData directory. */
export function readCredentialFile(path: string, read: (path: string, encoding: "utf8") => string = readFileSync) {
  try {
    return read(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export function credentialFile(userDataDir: string): CredentialFile {
  const path = join(userDataDir, ACCOUNT_CREDENTIAL_RECORD)
  const syncDirectory = () => {
    let descriptor: number | undefined
    try {
      descriptor = openSync(userDataDir, "r")
      fsyncSync(descriptor)
    } catch {
      // Some platforms do not permit fsync on a directory. The credential
      // bytes were still flushed before rename; directory durability is best
      // effort where the OS exposes it.
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }
  return {
    read: () => readCredentialFile(path),
    replace: (contents) => {
      const temporary = join(userDataDir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
      let descriptor: number | undefined
      try {
        descriptor = openSync(temporary, "wx", 0o600)
        writeFileSync(descriptor, contents, "utf8")
        fsyncSync(descriptor)
        closeSync(descriptor)
        descriptor = undefined
        renameSync(temporary, path)
        syncDirectory()
      } finally {
        if (descriptor !== undefined) closeSync(descriptor)
        rmSync(temporary, { force: true })
      }
    },
    quarantine: () => {
      try {
        renameSync(path, join(userDataDir, `${ACCOUNT_CREDENTIAL_RECORD}.rejected-${randomUUID()}`))
        syncDirectory()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    },
    clear: () => {
      rmSync(path, { force: true })
      syncDirectory()
    },
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
  id_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  error?: string
}

/**
 * Compact JWTs have three base64url segments. Clerk can still issue opaque
 * OAuth access tokens; those fail control-plane JWKS verification.
 */
export function isJwtShaped(token: string) {
  const parts = token.split(".")
  return parts.length === 3 && parts.every((part) => part.length > 0)
}

/**
 * Bearer the hosted control plane can verify with `CLERK_JWKS_URL`.
 *
 * Prefer a JWT `access_token`. When the OAuth app still issues opaque access
 * tokens, fall back to the OIDC `id_token` (always a JWT when `openid` was
 * granted). Opaque-only responses keep the access token so userinfo/sign-in
 * still work, but People/hosted ops will 401 until JWT access tokens are
 * enabled on the Clerk OAuth app.
 */
export function controlPlaneBearerFromTokenPayload(payload: {
  access_token?: string
  id_token?: string
}): string | undefined {
  if (payload.access_token && isJwtShaped(payload.access_token)) return payload.access_token
  if (payload.id_token && isJwtShaped(payload.id_token)) return payload.id_token
  return payload.access_token
}

/**
 * POST to the token endpoint.
 *
 * Form-encoded with no client secret — a native app cannot keep one, which is
 * why PKCE carries the proof on the authorization-code grant, and why the
 * refresh grant sends only the client id beside the token.
 */
const TOKEN_REQUEST_TIMEOUT_MS = 30_000

async function postToTokenEndpoint(
  fetchImpl: typeof fetch,
  tokenUrl: string,
  form: Record<string, string>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
) {
  const controller = new AbortController()
  let rejectAborted!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject
  })
  const abortFromParent = () => {
    const reason = parentSignal?.reason instanceof Error ? parentSignal.reason : new Error("token request cancelled")
    controller.abort(reason)
    rejectAborted(reason)
  }
  if (parentSignal?.aborted) abortFromParent()
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true })

  let handle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => {
      const error = new Error(`token endpoint timed out after ${String(timeoutMs)}ms`)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
    // Deliberately ref'd, unlike nodeTimer(): this timer is the race's only
    // wake-up when the transport holds no live handle, and bun on win32 never
    // fires an unref'd timer once the loop has no ref'd handles left — which
    // turned this bounded timeout into a permanent hang (CI unit lane, run
    // 374). It cannot outlive the request it bounds: at most timeoutMs, and
    // cleared in the finally below the moment the race settles. A pending
    // real fetch refs the loop on its own, so quit behavior is unchanged.
  })

  try {
    return await Promise.race([
      fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form).toString(),
        signal: controller.signal,
      }),
      timeout,
      aborted,
    ])
  } finally {
    if (handle) clearTimeout(handle)
    parentSignal?.removeEventListener("abort", abortFromParent)
  }
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
  const accessToken = controlPlaneBearerFromTokenPayload(payload)
  if (
    !accessToken ||
    typeof payload.expires_in !== "number" ||
    !Number.isFinite(payload.expires_in) ||
    payload.expires_in <= 0
  ) return undefined
  const refreshToken = payload.refresh_token ?? fallbackRefreshToken
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    // Absolute, in seconds. Storing the relative `expires_in` would mean
    // every reader has to remember when it was issued.
    expiresAt: Math.floor(Date.now() / 1000) + payload.expires_in,
  }
}

/** The Authorization Code exchange. */
export function tokenExchange(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TOKEN_REQUEST_TIMEOUT_MS,
): OAuthSeams["exchange"] {
  return async (input) => {
    const response = await postToTokenEndpoint(
      fetchImpl,
      input.tokenUrl,
      {
        grant_type: "authorization_code",
        client_id: input.clientId,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
        ...(input.resource ? { resource: input.resource } : {}),
      },
      timeoutMs,
      input.signal,
    )
    if (!response.ok) throw new Error(`token exchange failed: ${response.status}`)
    const tokens = decodeTokenPayload((await response.json()) as TokenPayload)
    // Throwing, unlike the refresh grant below: this one runs inside a sign-in
    // attempt that already has a failure channel, and there is no existing
    // session whose fate depends on telling the causes apart.
    if (!tokens) throw new Error("token exchange returned no valid access token and lifetime")
    return tokens
  }
}

export type RefreshExchange = (input: {
  tokenUrl: string
  clientId: string
  refreshToken: string
  resource?: string
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
export function refreshExchange(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TOKEN_REQUEST_TIMEOUT_MS,
): RefreshExchange {
  return async (input) => {
    let response: Response
    try {
      response = await postToTokenEndpoint(
        fetchImpl,
        input.tokenUrl,
        {
          grant_type: "refresh_token",
          client_id: input.clientId,
          refresh_token: input.refreshToken,
          ...(input.resource ? { resource: input.resource } : {}),
        },
        timeoutMs,
      )
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
        ? {
            ok: false,
            reason: "revoked",
            detail: `the authorization server rejected the refresh token (${response.status})`,
          }
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
