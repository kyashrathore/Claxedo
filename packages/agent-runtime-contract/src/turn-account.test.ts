import { describe, expect, test } from "bun:test"
import { turnAccount, turnAccountFor } from "./turn-account"

const minted = { baseUrl: "http://127.0.0.1:2595/bindings/61b4", placeholder: "signed-placeholder", authMode: "api-key" as const }
const account = { credentialId: "cred-1", providerId: "claude-sdk", label: "contactyash" }

describe("the account a turn runs on", () => {
  test("names a stored credential, the machine's login, or nothing it cannot know", () => {
    expect(turnAccountFor("claude", { ...minted, account })).toEqual({ kind: "stored", harnessId: "claude", ...account })
    expect(turnAccountFor("codex", undefined)).toEqual({ kind: "machine", harnessId: "codex" })
    expect(turnAccountFor("claude", minted)).toBeUndefined()
    expect(turnAccountFor("claude", { unavailable: true, reason: "revoked" })).toBeUndefined()
  })

  test("reads back only a well-formed account", () => {
    expect(turnAccount({ kind: "stored", harnessId: "pi", ...account })).toEqual({ kind: "stored", harnessId: "pi", ...account })
    expect(turnAccount({ kind: "machine", harnessId: "cursor" })).toEqual({ kind: "machine", harnessId: "cursor" })
    expect(turnAccount({ kind: "stored", harnessId: "claude", providerId: "claude-sdk" })).toBeUndefined()
    expect(turnAccount({ kind: "machine", harnessId: "opencode" })).toBeUndefined()
  })
})
