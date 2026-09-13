import { describe, expect, test } from "vitest"
import { credentialSecretMaterial, emailFromClaims } from "./secret-material"

function jwt(claims: Record<string, unknown>) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`
}

describe("emailFromClaims", () => {
  test("reads the address out of an id_token", () => {
    expect(emailFromClaims({
      tokens: {
        id_token: jwt({ email: "owner@example.com" }),
        access_token: jwt({ email: "stale@example.com" }),
      },
    })).toBe("owner@example.com")
  })

  test("falls back to the access token when the login carries no id_token", () => {
    expect(emailFromClaims({ access_token: jwt({ email: "access@example.com" }) })).toBe("access@example.com")
    expect(emailFromClaims({ access: jwt({ email: "oauth@example.com" }) })).toBe("oauth@example.com")
    expect(emailFromClaims({ tokens: { access_token: jwt({ email: "nested@example.com" }) } }))
      .toBe("nested@example.com")
  })

  test("reads the OpenAI auth namespace when the top-level claims name no address", () => {
    expect(emailFromClaims({
      id_token: jwt({
        preferred_username: "not-an-address",
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_1", email: "namespaced@example.com" },
      }),
    })).toBe("namespaced@example.com")
  })

  test("takes preferred_username only when it is an address", () => {
    expect(emailFromClaims({ id_token: jwt({ preferred_username: "person@example.com" }) }))
      .toBe("person@example.com")
    expect(emailFromClaims({ id_token: jwt({ preferred_username: "person" }) })).toBeUndefined()
  })

  test("names no account when the token is not a JWT, does not decode, or carries no address", () => {
    expect(emailFromClaims(undefined)).toBeUndefined()
    expect(emailFromClaims({ access_token: "sk-ant-oat01-not-a-jwt" })).toBeUndefined()
    expect(emailFromClaims({ access_token: "header.@@not-base64@@.signature" })).toBeUndefined()
    expect(emailFromClaims({ access_token: jwt({ chatgpt_account_id: "acct_1" }) })).toBeUndefined()
    expect(emailFromClaims({ access_token: jwt({ email: "" }) })).toBeUndefined()
  })
})

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
