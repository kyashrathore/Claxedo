import { describe, expect, test } from "bun:test"
import { googleIntegration } from "./google.js"

const OPTS = {
  clientId: "cid",
  clientSecret: "csecret",
  redirectUri: "https://host.test/api/claxedo/integrations/callback",
  scopes: ["https://www.googleapis.com/auth/drive.file"],
  now: () => 1_000_000,
}

describe("google integration (vendored arctic)", () => {
  test("authorize URL golden shape: PKCE + offline access + consent", async () => {
    const { decl, impl } = googleIntegration(OPTS)
    expect(decl).toMatchObject({ id: "google", methods: ["oauth"], capabilities: ["docs"] })
    const url = new URL(String(await impl.authorize!("state-1", "verifier-1")))
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("cid")
    expect(url.searchParams.get("redirect_uri")).toBe(OPTS.redirectUri)
    expect(url.searchParams.get("state")).toBe("state-1")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toBeTruthy()
    expect(url.searchParams.get("scope")).toBe(OPTS.scopes[0])
    expect(url.searchParams.get("access_type")).toBe("offline")
    expect(url.searchParams.get("prompt")).toBe("consent")
  })

  test("exchange golden request shape and token mapping", async () => {
    const seen: Array<{ url: string; body: string; auth: string | null; timed: boolean }> = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        body: await new Response(init?.body).text(),
        auth: new Headers(init?.headers).get("authorization"),
        timed: !!init?.signal,
      })
      return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" })
    }
    const { impl } = googleIntegration({ ...OPTS, fetchImpl })
    const tokens = await impl.callback!("the-code", "the-verifier")
    expect(tokens).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000 + 3600 * 1000 })
    expect(seen[0]!.url).toBe("https://oauth2.googleapis.com/token")
    const body = new URLSearchParams(seen[0]!.body)
    expect(body.get("grant_type")).toBe("authorization_code")
    expect(body.get("code")).toBe("the-code")
    expect(body.get("code_verifier")).toBe("the-verifier")
    expect(body.get("redirect_uri")).toBe(OPTS.redirectUri)
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from("cid:csecret").toString("base64")}`)
    // The OAuth exchange is bounded like every other provider call.
    expect(seen[0]!.timed).toBe(true)
  })

  test("refresh golden request shape; 4xx maps to OAuth2RequestError", async () => {
    let call = 0
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      call += 1
      if (call === 1) {
        const body = new URLSearchParams(await new Response(init?.body).text())
        expect(body.get("grant_type")).toBe("refresh_token")
        expect(body.get("refresh_token")).toBe("rt-0")
        return Response.json({ access_token: "at-2", expires_in: 3600, token_type: "Bearer" })
      }
      return Response.json({ error: "invalid_grant" }, { status: 400 })
    }
    const { impl } = googleIntegration({ ...OPTS, fetchImpl })
    expect(await impl.refresh!("rt-0")).toEqual({ accessToken: "at-2", expiresAt: 1_000_000 + 3_600_000 })
    await expect(impl.refresh!("rt-0")).rejects.toMatchObject({ code: "invalid_grant" })
  })

  test("a provider that never answers is aborted at the injected deadline", async () => {
    let aborted: unknown
    const fetchImpl = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = init.signal?.reason
          reject(init.signal?.reason)
        })
      })
    const { impl } = googleIntegration({ ...OPTS, fetchImpl, timeoutMs: 5 })
    await expect(impl.refresh!("rt-0")).rejects.toThrow("Failed to send request")
    expect((aborted as Error | undefined)?.name).toBe("TimeoutError")
  })
})
