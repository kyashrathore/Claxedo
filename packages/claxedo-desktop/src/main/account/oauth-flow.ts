/**
 * The desktop's sign-in: system browser, loopback callback, code exchange.
 *
 * `pkce.ts` holds the cryptographic decisions and `secure-storage.ts` decides
 * whether this machine may hold a credential at all. This file is the order of
 * operations, which is where the remaining mistakes live — a listener that
 * outlives a failed attempt, an exchange that runs on an unverified callback,
 * a second browser window opened because the first attempt never settled.
 *
 * Every effect is injected. The result is that the whole flow, including its
 * failure paths, is testable without Electron, a browser, or a network — and
 * the paths that only run when something goes wrong are the ones worth testing.
 */

import { buildAuthorizeUrl, createPkcePair, createState, loopbackRedirectUri, readCallback } from "./pkce"
import { secureStorageVerdict, type SafeStorageReport } from "./secure-storage"

export const REDIRECT_PATH = "/claxedo/auth/callback"

export type OAuthConfig = {
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  scope: string
  resource?: string
  /** How long to wait for the user to finish in the browser. */
  timeoutMs: number
}

export type TokenSet = {
  accessToken: string
  refreshToken?: string
  /** Seconds since the epoch. */
  expiresAt: number
}

/** What the callback listener tells the browser to display. */
export type CallbackDisposition = { status: number; body: string }

export type OAuthSeams = {
  /** Hands the URL to the OS browser. */
  openExternal: (url: string) => Promise<void>
  /**
   * Starts the loopback listener and resolves with its assigned port.
   *
   * The handler is called for every request the listener receives, including
   * ones that are not our callback; its return value is what the browser sees.
   */
  listen: (handler: (url: string) => CallbackDisposition) => Promise<{ port: number; close: () => Promise<void> }>
  exchange: (input: {
    tokenUrl: string
    clientId: string
    code: string
    codeVerifier: string
    redirectUri: string
    resource?: string
    signal?: AbortSignal
  }) => Promise<TokenSet>
  safeStorage: () => SafeStorageReport
  /** Milliseconds; injected so a timeout test does not wait for one. */
  setTimeout: (fn: () => void, ms: number) => { cancel: () => void }
}

export type SignInResult =
  | { ok: true; tokens: TokenSet }
  | { ok: false; reason: "no-secure-storage" | "callback-failed" | "timeout" | "already-running"; detail: string }

/**
 * One sign-in attempt at a time.
 *
 * Not a nicety. Two attempts mean two loopback listeners on different ports and
 * two `state` values, and the browser will return to exactly one of them — so
 * the other leaks a listening socket for its whole timeout. Refusing the second
 * attempt is also what the user means: clicking "Sign in" twice is impatience,
 * not a request for two sessions.
 */
export function createOAuthFlow(config: OAuthConfig, seams: OAuthSeams) {
  let running = false
  let active: AbortController | undefined

  return {
    isRunning: () => running,
    cancel() {
      active?.abort(new Error("sign-in cancelled"))
    },
    async signIn(): Promise<SignInResult> {
      if (running) return { ok: false, reason: "already-running", detail: "a sign-in attempt is already open" }

      // Checked BEFORE opening a browser. Discovering there is nowhere to put
      // the credential after the user has typed a password is both a worse
      // experience and a moment where the obvious fix is to store it anyway.
      const storage = secureStorageVerdict(seams.safeStorage())
      if (!storage.usable) return { ok: false, reason: "no-secure-storage", detail: storage.detail }

      running = true
      const controller = new AbortController()
      active = controller
      try {
        return await attempt(config, seams, controller.signal)
      } finally {
        if (active === controller) active = undefined
        running = false
      }
    },
  }
}

async function attempt(config: OAuthConfig, seams: OAuthSeams, signal: AbortSignal): Promise<SignInResult> {
  const pkce = createPkcePair()
  const state = createState()

  // The listener's own outcome, kept separate from `SignInResult`: the callback
  // produces a CODE, and whether that becomes a signed-in account is decided
  // afterwards by the exchange. Collapsing the two would mean inventing a token
  // set here to represent "the callback arrived".
  type Arrival = { ok: true; code: string } | { ok: false; reason: "callback-failed" | "timeout"; detail: string }
  let settle: (arrival: Arrival) => void = () => {}
  const arrived = new Promise<Arrival>((resolve) => {
    settle = resolve
  })
  const cancel = () => settle({ ok: false, reason: "callback-failed", detail: "sign-in cancelled" })
  signal.addEventListener("abort", cancel, { once: true })

  const server = await seams.listen((url) => {
    const result = readCallback({ url, expectedState: state, redirectPath: REDIRECT_PATH })
    if (!result.ok) {
      // A request that is not our callback (a favicon fetch, a probe) must not
      // end the attempt — only a real, state-matching callback does. But a
      // callback on the RIGHT path that fails verification is an answer.
      if (result.reason.startsWith("unexpected callback path")) {
        return { status: 404, body: "not found" }
      }
      settle({ ok: false, reason: "callback-failed", detail: result.reason })
      return { status: 400, body: "Sign-in failed. You can close this window." }
    }
    settle({ ok: true, code: result.code })
    return { status: 200, body: "Signed in. You can close this window." }
  })

  const timer = seams.setTimeout(() => {
    settle({ ok: false, reason: "timeout", detail: `no callback within ${config.timeoutMs}ms` })
  }, config.timeoutMs)

  try {
    await seams.openExternal(
      buildAuthorizeUrl({
        authorizeUrl: config.authorizeUrl,
        clientId: config.clientId,
        redirectUri: loopbackRedirectUri(server.port, REDIRECT_PATH),
        scope: config.scope,
        ...(config.resource ? { resource: config.resource } : {}),
        pkce,
        state,
      }),
    )

    const arrival = await arrived
    if (!arrival.ok) return arrival

    // Only now, and only with a code that survived the state check. The
    // verifier goes over this back channel and nowhere else.
    const tokens = await seams.exchange({
      tokenUrl: config.tokenUrl,
      clientId: config.clientId,
      code: arrival.code,
      codeVerifier: pkce.verifier,
      redirectUri: loopbackRedirectUri(server.port, REDIRECT_PATH),
      ...(config.resource ? { resource: config.resource } : {}),
      signal,
    })
    return { ok: true, tokens }
  } catch (error) {
    return { ok: false, reason: "callback-failed", detail: String(error) }
  } finally {
    // Both, on every path. A listening socket left behind after a failed
    // attempt is a port on the user's machine that accepts authorization codes.
    timer.cancel()
    signal.removeEventListener("abort", cancel)
    await server.close()
  }
}
