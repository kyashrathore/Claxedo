import { describe, expect, test } from "vitest"
import { credentialSecretMaterial, isAnthropicOAuthToken, pastedSecret, storedCredentialKind, subscriptionTokenRefusal } from "./secret-material"

function jwt(claims: Record<string, unknown>) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`
}

describe("credentialSecretMaterial", () => {
  test("carries the address a ChatGPT login's claims name", () => {
    const material = credentialSecretMaterial({
      kind: "oauth_token",
      secret: JSON.stringify({
        type: "codex_auth",
        tokens: {
          id_token: jwt({ email: "chatgpt@example.com", chatgpt_account_id: "acct_1" }),
          access_token: "access-token",
          account_id: "acct_1",
        },
      }),
    })

    expect(material).toEqual({ token: "access-token", accountId: "acct_1", email: "chatgpt@example.com", form: "subscription" })
  })

  test("leaves a bare token and a claimless login unnamed", () => {
    expect(credentialSecretMaterial({ kind: "api_key", secret: "sk-ant-api03-console-key" }))
      .toEqual({ token: "sk-ant-api03-console-key", form: "api-key" })
    expect(credentialSecretMaterial({
      kind: "oauth_token",
      secret: JSON.stringify({ type: "claude_code_oauth", claudeAiOauth: { accessToken: "sk-ant-oat01-keychain" } }),
    })).toEqual({ token: "sk-ant-oat01-keychain", form: "subscription" })
  })

  test("a bare token copied across a wrapped terminal line is the token without the break", () => {
    expect(credentialSecretMaterial({ kind: "oauth_token", secret: "sk-ant-oat01-wrapped\n token" }))
      .toEqual({ token: "sk-ant-oat01-wrappedtoken", form: "subscription" })
    expect(credentialSecretMaterial({ kind: "oauth_token", secret: "sk-ant-oat01-wrapped  token" }))
      .toEqual({ token: "sk-ant-oat01-wrappedtoken", form: "subscription" })
    expect(credentialSecretMaterial({ kind: "api_key", secret: " sk-ant-api03-wrapped\n\tkey\n" }))
      .toEqual({ token: "sk-ant-api03-wrappedkey", form: "api-key" })
  })
})

describe("pastedSecret", () => {
  test("a bare key or token loses every space and line break; a login document keeps its own", () => {
    expect(pastedSecret(" sk-ant-oat01-wrapped\n token\n")).toBe("sk-ant-oat01-wrappedtoken")
    expect(pastedSecret("sk-ant-oat01-wrapped  token")).toBe("sk-ant-oat01-wrappedtoken")
    const document = JSON.stringify({ tokens: { access_token: "access token", account_id: "acct 1" } }, null, 2)
    expect(pastedSecret(` ${document}\n`)).toBe(document)
  })
})

describe("storedCredentialKind", () => {
  test("a pasted key keeps its kind unless the secret is an OAuth token", () => {
    expect(storedCredentialKind({ kind: "api_key", secret: "sk-ant-api03-console-key" })).toBe("api_key")
    expect(storedCredentialKind({ kind: "api_key", secret: " sk-ant-oat01-setup-token " })).toBe("oauth_token")
    expect(storedCredentialKind({ kind: "api_key", secret: JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x" } }) }))
      .toBe("oauth_token")
  })

  test("only the key field's kind is read; every other kind is the caller's word", () => {
    expect(storedCredentialKind({ kind: "oauth_token", secret: "sk-ant-api03-console-key" })).toBe("oauth_token")
    expect(storedCredentialKind({ kind: "subscription_session", secret: "sk-ant-oat01-x" })).toBe("subscription_session")
    expect(storedCredentialKind({ kind: "sandbox_driver", secret: "{}" })).toBe("sandbox_driver")
  })

  test("a refresh token is no plan login: the key field keeps it a key, as pi-ai sends it", () => {
    expect(storedCredentialKind({ kind: "api_key", secret: "sk-ant-ort01-refresh" })).toBe("api_key")
    expect(credentialSecretMaterial({ kind: "api_key", secret: "sk-ant-ort01-refresh" })).toEqual({ token: "sk-ant-ort01-refresh", form: "api-key" })
    expect(isAnthropicOAuthToken(" sk-ant-oat01-x ")).toBe(true)
    expect(isAnthropicOAuthToken("SK-ANT-OAT01-x")).toBe(false)
  })
})

describe("subscriptionTokenRefusal", () => {
  test("takes the access token `claude setup-token` prints, bare or inside a login document", () => {
    expect(subscriptionTokenRefusal(" sk-ant-oat01-setup-token\n")).toBeUndefined()
    expect(subscriptionTokenRefusal(JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-keychain", refreshToken: "sk-ant-ort01-x" } }))).toBeUndefined()
  })

  test("names what a refused value is, so the person knows where it goes", () => {
    expect(subscriptionTokenRefusal("sk-ant-api03-console-key")).toBe("This is an Anthropic API key. Add it under API Key.")
    expect(subscriptionTokenRefusal("sk-ant-ort01-refresh")).toMatch(/refresh token, not its access token.*sk-ant-oat01-/)
    expect(subscriptionTokenRefusal("not-a-token")).toMatch(/starts with sk-ant-oat01-/)
    expect(subscriptionTokenRefusal(JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-ort01-swapped" } }))).toMatch(/starts with sk-ant-oat01-/)
  })
})
