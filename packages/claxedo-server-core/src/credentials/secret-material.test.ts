import { describe, expect, test } from "vitest"
import { credentialSecretMaterial } from "./secret-material"

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
