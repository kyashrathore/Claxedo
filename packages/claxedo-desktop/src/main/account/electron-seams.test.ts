import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { credentialFile, refreshExchange, tokenExchange } from "./electron-seams"
import { ACCOUNT_CREDENTIAL_RECORD } from "./marker"
import { printedAlone } from "../test-support/printed-alone"

describe("tokenExchange", () => {
  const EXCHANGE_INPUT = {
    tokenUrl: "https://core.example/api/auth/oauth2/token",
    clientId: "desktop_1",
    code: "code_1",
    codeVerifier: "verifier_1",
    redirectUri: "http://127.0.0.1:49152/oauth/callback",
    resource: "https://core.example/api/claxedo",
  }

  test("spends the access token, never the id token, as the control-plane bearer", async () => {
    // An id_token is the client's proof of who signed in: it carries no scope,
    // cannot be revoked, and its audience is this client, not the control plane.
    const exchange = tokenExchange(async () => Response.json({
      access_token: "clx_at_opaque",
      id_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEifQ.sig",
      refresh_token: "rt_1",
      expires_in: 300,
    }))

    await expect(exchange(EXCHANGE_INPUT)).resolves.toMatchObject({ accessToken: "clx_at_opaque", refreshToken: "rt_1" })
  })

  test("refuses an id token in place of a missing access token", async () => {
    const exchange = tokenExchange(async () => Response.json({
      id_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEifQ.sig",
      expires_in: 300,
    }))

    await expect(exchange(EXCHANGE_INPUT)).rejects.toThrow("valid access token and lifetime")
  })

  test("rejects a token response without a finite positive lifetime", async () => {
    const exchange = tokenExchange(async () => Response.json({
      access_token: "clx_at_opaque",
      refresh_token: "rt_1",
    }))

    await expect(exchange(EXCHANGE_INPUT)).rejects.toThrow("valid access token and lifetime")
  })

  test("never retries: one attempt, bounded by a deadline, with a clear terminal error", async () => {
    let attempts = 0
    let aborted = false
    const exchange = tokenExchange((_url, init) => {
      attempts += 1
      // No response ever arrives; resolution only through the deadline abort.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true
          reject(new Error("socket destroyed"))
        })
      })
    }, 30)

    await expect(exchange(EXCHANGE_INPUT)).rejects.toThrow()
    expect(attempts, "no second attempt on a fresh connection").toBe(1)
    expect(aborted, "the stalled attempt's socket must be destroyed").toBe(true)
  })

  test("propagates parent cancellation", async () => {
    let attempts = 0
    const controller = new AbortController()
    const exchange = tokenExchange((_url, init) => {
      attempts += 1
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("sign-in cancelled")))
      })
    }, 5_000)

    const pending = exchange({ ...EXCHANGE_INPUT, signal: controller.signal })
    controller.abort(new Error("sign-in cancelled"))
    await expect(pending).rejects.toThrow("sign-in cancelled")
    expect(attempts).toBe(1)
  })

  test("never follows a redirect, which would resend the code and verifier to its target", async () => {
    const redirects: Array<RequestRedirect | undefined> = []
    const exchange = tokenExchange(async (_url, init) => {
      redirects.push(init?.redirect)
      return new Response(null, { status: 307, headers: { location: "https://elsewhere.example/token" } })
    })

    await expect(exchange(EXCHANGE_INPUT)).rejects.toThrow("redirect (307)")
    expect(redirects).toEqual(["manual"])
  })
})

describe("refreshExchange", () => {
  const REFRESH_INPUT = {
    tokenUrl: "https://core.example/api/auth/oauth2/token",
    clientId: "desktop_1",
    refreshToken: "rt_1",
  }

  test("a redirect is an unavailable deployment, never followed and never a revoked grant", async () => {
    const redirects: Array<RequestRedirect | undefined> = []
    const refresh = refreshExchange(async (_url, init) => {
      redirects.push(init?.redirect)
      return new Response(null, { status: 308, headers: { location: "https://elsewhere.example/token" } })
    })

    const outcome = await refresh(REFRESH_INPUT)
    expect(outcome).toMatchObject({ ok: false, reason: "unavailable" })
    expect(!outcome.ok && outcome.detail).toContain("redirect (308)")
    expect(redirects).toEqual(["manual"])
  })

  test("the caller's signal aborts the refresh grant's request", async () => {
    let aborted = false
    const controller = new AbortController()
    const refresh = refreshExchange((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true
          reject(new Error("account session ended"))
        })
      }), 5_000)

    const pending = refresh({ ...REFRESH_INPUT, signal: controller.signal })
    controller.abort(new Error("account session ended"))

    await expect(pending).resolves.toMatchObject({ ok: false, reason: "unavailable" })
    expect(aborted).toBe(true)
  })
})

describe("nodeTimer", () => {
  test("fires when it is the only pending work, as the sign-in deadline", () => {
    const module = JSON.stringify(new URL("./electron-seams.ts", import.meta.url).href)
    expect(printedAlone(`
      import(${module}).then(({ nodeTimer }) => nodeTimer()(() => console.log("fired"), 20))
    `)).toBe("fired")
  })
})

describe("credentialFile quarantine", () => {
  test("keeps only the newest rejected record and leaves other files alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "claxedo-credential-"))
    const file = credentialFile(dir)
    try {
      writeFileSync(join(dir, `${ACCOUNT_CREDENTIAL_RECORD}.rejected-earlier`), "older")
      writeFileSync(join(dir, "unrelated.json"), "kept")
      file.replace("first")
      file.quarantine("binding changed")
      file.replace("second")
      file.quarantine("binding changed again")

      const rejected = readdirSync(dir).filter((name) => name.startsWith(`${ACCOUNT_CREDENTIAL_RECORD}.rejected-`))
      expect(rejected).toHaveLength(1)
      expect(readFileSync(join(dir, rejected[0]), "utf8")).toBe("second")
      expect(readdirSync(dir).filter((name) => name !== rejected[0])).toEqual(["unrelated.json"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
