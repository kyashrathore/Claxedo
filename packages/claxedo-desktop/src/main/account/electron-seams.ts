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
import type { CallbackDisposition, OAuthSeams } from "./oauth-flow"
import type { CredentialFile } from "./credential-store"

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
  const path = join(userDataDir, "account-credential.json")
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

/**
 * The Authorization Code exchange.
 *
 * Form-encoded with no client secret — a native app cannot keep one, which is
 * why PKCE carries the proof instead.
 */
export function tokenExchange(fetchImpl: typeof fetch = fetch): OAuthSeams["exchange"] {
  return async (input) => {
    const response = await fetchImpl(input.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: input.clientId,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
      }).toString(),
    })
    if (!response.ok) throw new Error(`token exchange failed: ${response.status}`)
    const payload = (await response.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!payload.access_token) throw new Error("token exchange returned no access token")
    return {
      accessToken: payload.access_token,
      ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
      // Absolute, in seconds. Storing the relative `expires_in` would mean
      // every reader has to remember when it was issued.
      expiresAt: Math.floor(Date.now() / 1000) + (payload.expires_in ?? 3600),
    }
  }
}
