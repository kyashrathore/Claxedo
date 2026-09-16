import { describe, expect, test } from "vitest"
import { credentialSecretMaterial, storedCredentialKind } from "./secret-material"

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
})
