import { describe, expect, test } from "vitest"
import { secretHint } from "./pasted-key"

const key = (secret: string, provider_id = "cursor-sdk") => secretHint({ kind: "api_key", provider_id, secret })

describe("pasted key hint", () => {
  test("keeps the vendor's public prefix and the last four characters", () => {
    expect(key("sk-ant-api03-abcdefghijklmnop-WXYZ", "claude-sdk")).toBe("sk-ant-…WXYZ")
    expect(key("key_user_e2e_owner_long")).toBe("key_…long")
    expect(key("sk-proj-abcdefghijklmnop1234", "openai")).toBe("sk-…1234")
  })

  test("shows no prefix for a key without a vendor prefix, and nothing of a short key", () => {
    expect(key("AbCdEfGhIjKlMnOpQrSt")).toBe("…QrSt")
    expect(key("x_abcdefghijklmnopqr")).toBe("…opqr")
    expect(key("key_short")).toBeUndefined()
  })

  test("never holds more than seven characters of prefix and four of tail, each taken from the key itself", () => {
    for (const secret of ["sk-ant-api03-abcdefghijklmnop-WXYZ", "key_user_e2e_owner_long", "ab-cd-ef-gh-ij-kl-mn-op", "aaaaaaaaaaaaaaaaaaaaaaaa"]) {
      const hint = key(secret)!
      const [prefix, tail] = hint.split("…")
      expect(prefix.length).toBeLessThanOrEqual(7)
      expect(secret.startsWith(prefix)).toBe(true)
      expect(tail).toBe(secret.slice(-4))
      expect(hint.length).toBeLessThanOrEqual(12)
    }
  })

  test("leaves logins, sandbox drivers and namespaced secrets without a hint", () => {
    expect(secretHint({ kind: "oauth_token", provider_id: "claude-sdk", secret: "sk-ant-oat01-abcdefghijklmnop" })).toBeUndefined()
    expect(secretHint({ kind: "sandbox_driver", provider_id: "modal", secret: "ak-abcdefghijklmnopqrst" })).toBeUndefined()
    expect(secretHint({ kind: "api_key", provider_id: "integration:github", secret: "ghp_abcdefghijklmnopqrst" })).toBeUndefined()
  })
})
