import { describe, expect, test } from "bun:test"
import { githubIntegration } from "./github.js"
import { DefinitiveRefreshError } from "../tokens.js"

type Call = { url: string; body: URLSearchParams; accept: string | undefined }

function recording(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = []
  let index = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url,
      body: new URLSearchParams(String(init?.body ?? "")),
      accept: headers.get("Accept") ?? undefined,
    })
    const next = responses[Math.min(index++, responses.length - 1)]!
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const GRANT = {
  device_code: "device-abc",
  user_code: "WDJB-MJHT",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
}

describe("github device flow declaration", () => {
  test("without a client id the integration offers the pasted key only", () => {
    const decl = githubIntegration().decl
    expect(decl.methods).toEqual(["key"])
    expect(githubIntegration().impl.device).toBeUndefined()
    expect(githubIntegration().impl.refresh).toBeUndefined()
  })

  test("a configured client id adds oauth ahead of the key fallback", () => {
    const integration = githubIntegration({ clientId: "Iv1.client" })
    expect(integration.decl.methods).toEqual(["oauth", "key"])
    expect(integration.impl.device).toBeDefined()
    expect(integration.impl.refresh).toBeDefined()
    expect(integration.impl.verify).toBeDefined()
  })

  test("a blank client id reads as unconfigured, not as an empty-string client", () => {
    expect(githubIntegration({ clientId: "   " }).decl.methods).toEqual(["key"])
  })
})

describe("github device grant", () => {
  test("start asks for a device code and returns the code the user types", async () => {
    const { calls, fetchImpl } = recording([{ body: GRANT }])
    const integration = githubIntegration({ clientId: "Iv1.client", fetchImpl, now: () => 1_000 })

    const grant = await integration.impl.device!.start()

    expect(grant).toEqual({
      deviceCode: "device-abc",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      intervalMs: 5_000,
      expiresAt: 1_000 + 900_000,
    })
    expect(calls[0]!.url).toBe("https://github.com/login/device/code")
    expect(calls[0]!.body.get("client_id")).toBe("Iv1.client")
    // The token endpoints answer form-encoded unless JSON is asked for.
    expect(calls[0]!.accept).toBe("application/json")
  })

  test("start never sends the client secret — the device leg is public", async () => {
    const { calls, fetchImpl } = recording([{ body: GRANT }])
    await githubIntegration({ clientId: "Iv1.client", clientSecret: "shh", fetchImpl }).impl.device!.start()

    expect(calls[0]!.body.get("client_secret")).toBeNull()
  })

  test("a device grant refused by github throws rather than returning a half grant", async () => {
    const { fetchImpl } = recording([{ body: { error: "device_flow_disabled" } }])
    const integration = githubIntegration({ clientId: "Iv1.client", fetchImpl })

    await expect(integration.impl.device!.start()).rejects.toThrow("github_device_start_failed")
  })
})

describe("github device poll", () => {
  test("an unentered code reads as pending", async () => {
    const { calls, fetchImpl } = recording([{ body: { error: "authorization_pending" } }])
    const integration = githubIntegration({ clientId: "Iv1.client", fetchImpl })

    expect(await integration.impl.device!.poll("device-abc")).toEqual({ status: "pending" })
    expect(calls[0]!.url).toBe("https://github.com/login/oauth/access_token")
    expect(calls[0]!.body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code")
    expect(calls[0]!.body.get("device_code")).toBe("device-abc")
    expect(calls[0]!.body.get("client_secret")).toBeNull()
  })

  test("slow_down stays pending and carries github's widened interval", async () => {
    const { fetchImpl } = recording([{ body: { error: "slow_down", interval: 10 } }])
    const integration = githubIntegration({ clientId: "Iv1.client", fetchImpl })

    expect(await integration.impl.device!.poll("device-abc")).toEqual({ status: "pending", intervalMs: 10_000 })
  })

  test("an authorized grant returns the access and refresh tokens with an absolute expiry", async () => {
    const { fetchImpl } = recording([{
      body: {
        access_token: "ghu_access",
        refresh_token: "ghr_refresh",
        expires_in: 28_800,
        token_type: "bearer",
        scope: "",
      },
    }])
    const integration = githubIntegration({ clientId: "Iv1.client", fetchImpl, now: () => 5_000 })

    expect(await integration.impl.device!.poll("device-abc")).toEqual({
      status: "complete",
      tokens: { accessToken: "ghu_access", refreshToken: "ghr_refresh", expiresAt: 5_000 + 28_800_000 },
    })
  })

  test("an app with token expiry disabled yields a non-expiring token", async () => {
    const { fetchImpl } = recording([{ body: { access_token: "ghu_access", token_type: "bearer" } }])
    const integration = githubIntegration({ clientId: "Iv1.client", fetchImpl })

    expect(await integration.impl.device!.poll("device-abc")).toEqual({
      status: "complete",
      tokens: { accessToken: "ghu_access" },
    })
  })

  test("a user who clicks cancel is denied, not left pending", async () => {
    const { fetchImpl } = recording([{ body: { error: "access_denied" } }])
    const integration = githubIntegration({ clientId: "Iv1.client", fetchImpl })

    expect(await integration.impl.device!.poll("device-abc")).toEqual({ status: "denied" })
  })

  test("a lapsed device code is expired so the caller restarts instead of polling on", async () => {
    const { fetchImpl } = recording([{ body: { error: "expired_token" } }])
    const integration = githubIntegration({ clientId: "Iv1.client", fetchImpl })

    expect(await integration.impl.device!.poll("device-abc")).toEqual({ status: "expired" })
  })

  test("a misconfigured app is terminal — polling it forever would never succeed", async () => {
    for (const error of ["device_flow_disabled", "incorrect_client_credentials", "unsupported_grant_type", "incorrect_device_code"]) {
      const { fetchImpl } = recording([{ body: { error } }])
      const integration = githubIntegration({ clientId: "Iv1.client", fetchImpl })
      const result = await integration.impl.device!.poll("device-abc")
      expect(result.status === "denied" || result.status === "expired").toBe(true)
    }
  })

  test("a 5xx from github is transient and stays pending", async () => {
    const { fetchImpl } = recording([{ status: 502, body: {} }])
    const integration = githubIntegration({ clientId: "Iv1.client", fetchImpl })

    expect(await integration.impl.device!.poll("device-abc")).toEqual({ status: "pending" })
  })
})

describe("github token refresh", () => {
  test("refresh rotates both tokens and sends the client secret when one is configured", async () => {
    const { calls, fetchImpl } = recording([{
      body: { access_token: "ghu_new", refresh_token: "ghr_new", expires_in: 28_800 },
    }])
    const integration = githubIntegration({
      clientId: "Iv1.client",
      clientSecret: "shh",
      fetchImpl,
      now: () => 9_000,
    })

    expect(await integration.impl.refresh!("ghr_old")).toEqual({
      accessToken: "ghu_new",
      refreshToken: "ghr_new",
      expiresAt: 9_000 + 28_800_000,
    })
    expect(calls[0]!.body.get("grant_type")).toBe("refresh_token")
    expect(calls[0]!.body.get("refresh_token")).toBe("ghr_old")
    expect(calls[0]!.body.get("client_secret")).toBe("shh")
  })

  test("a device-flow app with no secret still refreshes — github does not require one", async () => {
    const { calls, fetchImpl } = recording([{ body: { access_token: "ghu_new", refresh_token: "ghr_new" } }])
    const integration = githubIntegration({ clientId: "Iv1.client", fetchImpl })

    expect((await integration.impl.refresh!("ghr_old")).accessToken).toBe("ghu_new")
    expect(calls[0]!.body.get("client_secret")).toBeNull()
  })

  test("a spent refresh token demands a reconnect instead of a silent retry", async () => {
    const { fetchImpl } = recording([{ body: { error: "bad_refresh_token" } }])
    const integration = githubIntegration({ clientId: "Iv1.client", fetchImpl })

    await expect(integration.impl.refresh!("ghr_old")).rejects.toBeInstanceOf(DefinitiveRefreshError)
  })

  test("github being unreachable is transient, so the next call retries", async () => {
    const integration = githubIntegration({
      clientId: "Iv1.client",
      fetchImpl: (async () => {
        throw new Error("socket hang up")
      }) as unknown as typeof fetch,
    })

    const thrown = await integration.impl.refresh!("ghr_old").catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(DefinitiveRefreshError)
  })
})
