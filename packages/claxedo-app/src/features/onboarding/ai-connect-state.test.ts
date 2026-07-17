import { describe, expect, test } from "bun:test"
import { aiConnectFailureCopy, aiConnectTransition, initialAIConnectState } from "./ai-connect-state"

describe("AI connect state", () => {
  test("can only become connected after a real ok verification result", () => {
    const saved = aiConnectTransition(initialAIConnectState(), { type: "save-started" })
    expect(saved.phase).toBe("saving")
    expect(aiConnectTransition(saved, { type: "verification-result", result: "ok" }).phase).toBe("saving")

    const verifying = aiConnectTransition(saved, { type: "verification-started", providerId: "anthropic" })
    expect(verifying.phase).toBe("verifying")
    expect(aiConnectTransition(verifying, { type: "verification-result", result: "ok" })).toEqual({
      phase: "connected",
      providerId: "anthropic",
    })
  })

  test.each([
    ["auth_failed", "rejected"],
    ["no_billing", "billing"],
    ["rate_capped", "rate limit"],
    ["expired", "expired"],
  ] as const)("keeps a saved %s credential amber with typed provider guidance", (result, copy) => {
    const verifying = aiConnectTransition(
      aiConnectTransition(initialAIConnectState(), { type: "save-started" }),
      { type: "verification-started", providerId: "anthropic" },
    )
    const state = aiConnectTransition(verifying, { type: "verification-result", result })

    expect(state).toEqual({ phase: "not-working", providerId: "anthropic", result })
    expect(aiConnectFailureCopy(result).toLowerCase()).toContain(copy)
  })

  test("tracks discovery preview without treating found credentials as connected", () => {
    const discovering = aiConnectTransition(initialAIConnectState(), { type: "discovery-started" })
    const preview = aiConnectTransition(discovering, {
      type: "discovery-succeeded",
      discoveryId: "discovery-1",
      items: [{ providerId: "anthropic", kind: "oauth_token", label: "Claude subscription", origin: "macOS Keychain" }],
    })

    expect(preview).toMatchObject({ phase: "preview", discoveryId: "discovery-1" })
    expect(preview.phase === "preview" && preview.items[0].selected).toBe(true)
  })

  test("keeps two accounts for the same provider independently selectable", () => {
    const preview = aiConnectTransition({ phase: "discovering" }, {
      type: "discovery-succeeded",
      discoveryId: "discovery-1",
      items: [
        { providerId: "codex-acp", kind: "oauth_token", label: "Codex A", accountId: "account-a", origin: "~/.codex/accounts/a.auth.json" },
        { providerId: "codex-acp", kind: "oauth_token", label: "Codex B", accountId: "account-b", origin: "~/.codex/accounts/b.auth.json" },
      ],
    })
    if (preview.phase !== "preview") throw new Error("expected preview")

    const changed = aiConnectTransition(preview, {
      type: "selection-changed",
      selectionId: preview.items[1].selectionId,
      selected: false,
    })
    expect(changed.phase === "preview" && changed.items.map((item) => item.selected)).toEqual([true, false])
  })
})
