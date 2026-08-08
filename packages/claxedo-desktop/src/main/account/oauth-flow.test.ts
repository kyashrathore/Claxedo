import { describe, expect, test } from "bun:test"
import { REDIRECT_PATH, createOAuthFlow, type OAuthSeams, type CallbackDisposition } from "./oauth-flow"
import type { SafeStorageReport } from "./secure-storage"

const CONFIG = {
  authorizeUrl: "https://accounts.example.com/oauth/authorize",
  tokenUrl: "https://accounts.example.com/oauth/token",
  clientId: "client_desktop",
  scope: "openid profile email",
  timeoutMs: 120_000,
}

const PORT = 49_152

type Harness = {
  seams: OAuthSeams
  /** Delivers a request to the running listener, as the browser would. */
  callback: (url: string) => CallbackDisposition
  opened: string[]
  exchanges: Array<{ code: string; codeVerifier: string; redirectUri: string }>
  closes: number
  fireTimeout: () => void
  timerCancels: number
}

function harness(overrides: {
  safeStorage?: SafeStorageReport
  exchange?: OAuthSeams["exchange"]
} = {}): Harness {
  let handler: ((url: string) => CallbackDisposition) | undefined
  let onTimeout: (() => void) | undefined
  const state: Harness = {
    opened: [],
    exchanges: [],
    closes: 0,
    timerCancels: 0,
    callback: (url) => handler!(url),
    fireTimeout: () => onTimeout!(),
    seams: {
      openExternal: async (url) => {
        state.opened.push(url)
      },
      listen: async (incoming) => {
        handler = incoming
        return {
          port: PORT,
          close: async () => {
            state.closes++
            handler = undefined
          },
        }
      },
      exchange:
        overrides.exchange ??
        (async (input) => {
          state.exchanges.push({ code: input.code, codeVerifier: input.codeVerifier, redirectUri: input.redirectUri })
          return { accessToken: "at", refreshToken: "rt", expiresAt: 9_999 }
        }),
      safeStorage: () => overrides.safeStorage ?? { available: true, platform: "darwin" },
      setTimeout: (fn) => {
        onTimeout = fn
        return {
          cancel: () => {
            state.timerCancels++
          },
        }
      },
    },
  }
  return state
}

/**
 * The `state` the LATEST attempt generated, read out of its authorize URL.
 *
 * Latest, not first: each attempt mints a fresh state, so a test that reused
 * the first attempt's value would be asserting the flow reuses one — which it
 * must not.
 */
function issuedState(opened: string[]) {
  return new URL(opened.at(-1)!).searchParams.get("state")!
}

describe("signIn", () => {
  test("opens the system browser and exchanges a verified code", async () => {
    const h = harness()
    const flow = createOAuthFlow(CONFIG, h.seams)

    const pending = flow.signIn()
    // Wait for the listener and browser open to have happened.
    await Promise.resolve()
    await Promise.resolve()
    h.callback(`${REDIRECT_PATH}?code=the-code&state=${issuedState(h.opened)}`)

    await expect(pending).resolves.toEqual({
      ok: true,
      tokens: { accessToken: "at", refreshToken: "rt", expiresAt: 9_999 },
    })
    expect(h.exchanges).toHaveLength(1)
    expect(h.exchanges[0]!.code).toBe("the-code")
  })

  test("sends the verifier only on the back channel", async () => {
    // The authorize URL goes to the browser — history, logs, the address bar.
    // The verifier appearing there would defeat PKCE; it belongs in the
    // server-to-server exchange and nowhere else.
    const h = harness()
    const flow = createOAuthFlow(CONFIG, h.seams)
    const pending = flow.signIn()
    await Promise.resolve()
    await Promise.resolve()
    h.callback(`${REDIRECT_PATH}?code=the-code&state=${issuedState(h.opened)}`)
    await pending

    const verifier = h.exchanges[0]!.codeVerifier
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(h.opened[0]).not.toContain(verifier)
    expect(new URL(h.opened[0]!).searchParams.get("code_challenge")).not.toBe(verifier)
  })

  test("exchanges against the same redirect URI it authorized with", async () => {
    // The authorization server compares them. A mismatch is a rejected exchange
    // after the user has already signed in, which reads as a random failure.
    const h = harness()
    const flow = createOAuthFlow(CONFIG, h.seams)
    const pending = flow.signIn()
    await Promise.resolve()
    await Promise.resolve()
    h.callback(`${REDIRECT_PATH}?code=the-code&state=${issuedState(h.opened)}`)
    await pending

    expect(h.exchanges[0]!.redirectUri).toBe(new URL(h.opened[0]!).searchParams.get("redirect_uri"))
    expect(h.exchanges[0]!.redirectUri).toBe(`http://127.0.0.1:${PORT}${REDIRECT_PATH}`)
  })

  test("never exchanges a code whose state did not match", async () => {
    // The attack this defends: a local process hands the listener a code of its
    // own and the user ends up signed into someone else's account.
    const h = harness()
    const flow = createOAuthFlow(CONFIG, h.seams)
    const pending = flow.signIn()
    await Promise.resolve()
    await Promise.resolve()
    h.callback(`${REDIRECT_PATH}?code=attacker-code&state=wrong`)

    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("callback-failed")
    expect(h.exchanges).toEqual([])
  })

  test("ignores traffic on other paths without ending the attempt", async () => {
    // A favicon request or a port scan must not cancel a sign-in the user is
    // still completing.
    const h = harness()
    const flow = createOAuthFlow(CONFIG, h.seams)
    const pending = flow.signIn()
    await Promise.resolve()
    await Promise.resolve()

    expect(h.callback("/favicon.ico")).toEqual({ status: 404, body: "not found" })
    h.callback(`${REDIRECT_PATH}?code=the-code&state=${issuedState(h.opened)}`)

    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  test("closes the listener on success, failure and timeout", async () => {
    // A listening socket outliving an attempt is a port on the user's machine
    // that accepts authorization codes.
    for (const finish of [
      (h: Harness) => h.callback(`${REDIRECT_PATH}?code=c&state=${issuedState(h.opened)}`),
      (h: Harness) => h.callback(`${REDIRECT_PATH}?code=c&state=wrong`),
      (h: Harness) => h.fireTimeout(),
    ]) {
      const h = harness()
      const pending = createOAuthFlow(CONFIG, h.seams).signIn()
      await Promise.resolve()
      await Promise.resolve()
      finish(h)
      await pending

      expect(h.closes).toBe(1)
      expect(h.timerCancels).toBe(1)
    }
  })

  test("closes the listener when the exchange itself throws", async () => {
    const h = harness({
      exchange: async () => {
        throw new Error("token endpoint said no")
      },
    })
    const flow = createOAuthFlow(CONFIG, h.seams)
    const pending = flow.signIn()
    await Promise.resolve()
    await Promise.resolve()
    h.callback(`${REDIRECT_PATH}?code=c&state=${issuedState(h.opened)}`)

    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.detail).toContain("token endpoint said no")
    expect(h.closes).toBe(1)
  })

  test("times out instead of waiting forever", async () => {
    const h = harness()
    const pending = createOAuthFlow(CONFIG, h.seams).signIn()
    await Promise.resolve()
    await Promise.resolve()
    h.fireTimeout()

    const result = await pending
    expect(result.ok === false && result.reason).toBe("timeout")
    expect(h.exchanges).toEqual([])
  })

  test("refuses before opening a browser when there is nowhere to store the credential", async () => {
    // Order matters. Finding this out after the user has typed a password is
    // both a worse experience and the moment where "just store it anyway"
    // starts to look reasonable.
    const h = harness({ safeStorage: { available: true, platform: "linux", backend: "basic_text" } })

    const result = await createOAuthFlow(CONFIG, h.seams).signIn()

    expect(result.ok === false && result.reason).toBe("no-secure-storage")
    expect(h.opened).toEqual([])
    expect(h.closes).toBe(0)
  })

  test("refuses a second concurrent attempt", async () => {
    // Two attempts mean two listeners and two states; the browser returns to
    // one, and the other holds a socket open for its whole timeout.
    const h = harness()
    const flow = createOAuthFlow(CONFIG, h.seams)
    const first = flow.signIn()
    await Promise.resolve()
    await Promise.resolve()

    const second = await flow.signIn()
    expect(second.ok === false && second.reason).toBe("already-running")
    expect(h.opened).toHaveLength(1)

    h.callback(`${REDIRECT_PATH}?code=c&state=${issuedState(h.opened)}`)
    await first
    expect(flow.isRunning()).toBe(false)
  })

  test("allows a new attempt after one fails", async () => {
    // The single-flight latch must clear on the failure path too, or one
    // timeout permanently disables sign-in until the app restarts.
    const h = harness()
    const flow = createOAuthFlow(CONFIG, h.seams)
    const first = flow.signIn()
    await Promise.resolve()
    await Promise.resolve()
    h.fireTimeout()
    await first

    const second = flow.signIn()
    await Promise.resolve()
    await Promise.resolve()
    h.callback(`${REDIRECT_PATH}?code=c&state=${issuedState(h.opened)}`)

    await expect(second).resolves.toMatchObject({ ok: true })
  })
})
