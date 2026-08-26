import { describe, expect, test } from "bun:test"
import {
  aiConnectFailureCopy,
  aiConnectTransition,
  connectionDisplayName,
  destinationStoresCredentials,
  groupConnectResults,
  groupDiscoveryItems,
  initialAIConnectState,
  localHarnessStatuses,
  isUsableResult,
} from "./ai-connect-state"

const claudeBindings = [
  {
    providerId: "claude-acp",
    kind: "oauth_token",
    label: "Claude Code login · ACP adapter",
    origin: "macOS Keychain or ~/.claude/.credentials.json",
  },
  {
    providerId: "claude-sdk",
    kind: "oauth_token",
    label: "Claude Code login · agent SDK",
    origin: "macOS Keychain or ~/.claude/.credentials.json",
  },
]

describe("AI connect state", () => {
  test("settles with every credential's own verdict", () => {
    const saved = aiConnectTransition(initialAIConnectState(), { type: "save-started" })
    expect(saved.phase).toBe("saving")

    const results = [
      { credentialId: "c1", providerId: "anthropic", result: "ok" as const },
      { credentialId: "c2", providerId: "codex-acp", result: "expired" as const },
    ]
    expect(aiConnectTransition(saved, { type: "settled", results })).toEqual({ phase: "settled", results })
  })

  test("a failing credential no longer hides the ones that worked", () => {
    // The old reduction took the first non-ok result and returned early, so a
    // batch where three of four verified was reported as a total failure.
    const settled = aiConnectTransition(
      { phase: "saving" },
      {
        type: "settled",
        results: [
          { credentialId: "c1", providerId: "anthropic", result: "expired" },
          { credentialId: "c2", providerId: "anthropic", result: "ok" },
          { credentialId: "c3", providerId: "openai", result: "ok" },
        ],
      },
    )

    expect(settled.phase === "settled" && settled.results.filter((r) => isUsableResult(r.result)).length).toBe(2)
  })

  test("a rate-capped credential counts as usable", () => {
    expect(isUsableResult("rate_capped")).toBe(true)
    expect(isUsableResult("ok")).toBe(true)
    expect(isUsableResult("auth_failed")).toBe(false)
    expect(isUsableResult("expired")).toBe(false)
    expect(isUsableResult("no_billing")).toBe(false)
  })

  test.each([
    ["auth_failed", "rejected"],
    ["no_billing", "billing"],
    ["rate_capped", "usage limit"],
    ["expired", "expired"],
  ] as const)("gives a saved %s credential typed provider guidance", (result, copy) => {
    expect(aiConnectFailureCopy(result).toLowerCase()).toContain(copy)
  })

  test("a working credential needs no failure copy", () => {
    expect(aiConnectFailureCopy("ok")).toBe("")
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

  test("a local-only destination confirms what it found and never opens a save", () => {
    // The whole point of A0: nothing to commit, so there is no discovery id to
    // commit it against and no checkbox implying there is a choice to make.
    const confirmed = aiConnectTransition(
      { phase: "discovering" },
      {
        type: "discovery-succeeded",
        discoveryId: "discovery-1",
        destination: "local",
        items: claudeBindings,
      },
    )

    expect(confirmed.phase).toBe("confirmed")
    expect(confirmed.phase === "confirmed" && confirmed.rows.map((row) => row.label)).toEqual(["Claude Code login"])
    expect(JSON.stringify(confirmed)).not.toContain("discovery-1")
  })

  test.each(["cloud", "both"] as const)(
    "a %s destination still collects, because a sandbox has no login of its own",
    (destination) => {
      const state = aiConnectTransition(
        { phase: "discovering" },
        {
          type: "discovery-succeeded",
          discoveryId: "discovery-1",
          destination,
          items: claudeBindings,
        },
      )

      expect(state).toMatchObject({ phase: "preview", discoveryId: "discovery-1" })
      expect(destinationStoresCredentials(destination)).toBe(true)
    },
  )

  test("an unset destination collects exactly as before, so the flow that has no question yet is unchanged", () => {
    const state = aiConnectTransition(
      { phase: "discovering" },
      {
        type: "discovery-succeeded",
        discoveryId: "discovery-1",
        items: claudeBindings,
      },
    )

    expect(state.phase).toBe("preview")
  })

  test("only a local destination declines to store", () => {
    expect(destinationStoresCredentials("local")).toBe(false)
    expect(destinationStoresCredentials("cloud")).toBe(true)
    expect(destinationStoresCredentials("both")).toBe(true)
  })

  test("two harness bindings of one Claude login collect as one row that saves under both", () => {
    const rows = groupDiscoveryItems(claudeBindings)

    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe("Claude Code login")
    expect(rows[0].bindings).toEqual(["ACP adapter", "agent SDK"])
    expect(rows[0].providerIds).toEqual(["claude-acp", "claude-sdk"])
  })

  test("the merged row is keyed on credential identity, not on the label the server varies per binding", () => {
    // The server deliberately gives the two bindings different labels so they
    // could be told apart — which makes the label the one field that cannot
    // identify them as the same login.
    const rows = groupDiscoveryItems([
      { ...claudeBindings[0], label: "Claude token from CLAUDE_CODE_OAUTH_TOKEN · ACP adapter" },
      { ...claudeBindings[1], label: "Claude token from CLAUDE_CODE_OAUTH_TOKEN · agent SDK" },
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe("Claude token from CLAUDE_CODE_OAUTH_TOKEN")
  })

  test("two Codex accounts stay two rows — different accounts are different credentials", () => {
    const rows = groupDiscoveryItems([
      {
        providerId: "codex-acp",
        kind: "oauth_token",
        label: "Synced from local Codex auth",
        accountId: "account…a",
        origin: "~/.codex/auth.json",
      },
      {
        providerId: "codex-acp",
        kind: "oauth_token",
        label: "Synced from local Codex auth",
        accountId: "account…b",
        origin: "~/.codex/accounts/b.auth.json",
      },
    ])

    expect(rows.map((row) => row.accountId)).toEqual(["account…a", "account…b"])
  })

  test("a merged row is only already-connected when every binding is, and never over-promises a probe", () => {
    const partial = groupDiscoveryItems([
      { ...claudeBindings[0], alreadyConnected: true, probe: { state: "working" } },
      { ...claudeBindings[1], probe: { state: "broken", reason: "The provider rejected this credential." } },
    ])

    expect(partial[0].alreadyConnected).toBe(false)
    expect(partial[0].probe).toEqual({ state: "broken", reason: "The provider rejected this credential." })
    // Broken is never pre-selected, merged or not.
    expect(partial[0].selected).toBe(false)
  })

  test("both bindings of one login settle as a single verdict, and a failure on either wins", () => {
    const results = groupConnectResults([
      { credentialId: "c1", providerId: "claude-acp", result: "ok" },
      { credentialId: "c2", providerId: "claude-sdk", result: "auth_failed" },
      { credentialId: "c3", providerId: "codex-acp", result: "ok" },
    ])

    expect(results).toEqual([
      { credentialId: "c2", providerId: "claude-sdk", result: "auth_failed" },
      { credentialId: "c3", providerId: "codex-acp", result: "ok" },
    ])
  })

  test("a harness with no login reports missing rather than being left out", () => {
    const statuses = localHarnessStatuses(groupDiscoveryItems(claudeBindings))

    expect(statuses.map((harness) => harness.id)).toEqual(["claude", "codex", "cursor"])
    expect(statuses.filter((harness) => harness.state === "missing").map((harness) => harness.id)).toEqual([
      "codex",
      "cursor",
    ])
  })

  test("a probe we could not run is 'unverifiable', never conflated with working", () => {
    // The distinction the whole checklist rests on: a tick must mean the
    // provider answered, not that a file exists on disk.
    const statuses = localHarnessStatuses(
      groupDiscoveryItems([
        {
          providerId: "cursor-acp",
          kind: "api_key",
          label: "Cursor",
          origin: "CURSOR_API_KEY",
          probe: { state: "unknown", reason: "Claxedo can't check this provider yet." },
        },
      ]),
    )

    expect(statuses.find((harness) => harness.id === "cursor")).toMatchObject({
      state: "unverifiable",
      detail: "Claxedo can't check this provider yet.",
    })
  })

  test("a found login with no probe at all is unverifiable, not assumed good", () => {
    const statuses = localHarnessStatuses(
      groupDiscoveryItems([
        { providerId: "codex-acp", kind: "oauth_token", label: "Codex", origin: "~/.codex/auth.json" },
      ]),
    )

    expect(statuses.find((harness) => harness.id === "codex")?.state).toBe("unverifiable")
  })

  test("one working binding is enough — a harness reports its best outcome", () => {
    // Claude's two bindings carry the same secret. If either answered, the
    // harness runs; a second row would ask the user to weigh a distinction
    // that does not change what they can do next.
    const statuses = localHarnessStatuses(
      groupDiscoveryItems([
        { ...claudeBindings[0], origin: "macOS Keychain", probe: { state: "working" } },
        {
          ...claudeBindings[1],
          origin: "Environment variable CLAUDE_CODE_OAUTH_TOKEN",
          probe: { state: "broken", reason: "rejected" },
        },
      ]),
    )

    expect(statuses.find((harness) => harness.id === "claude")?.state).toBe("working")
  })

  test("a rejected login is broken and carries its reason", () => {
    const statuses = localHarnessStatuses(
      groupDiscoveryItems([
        {
          providerId: "codex-acp",
          kind: "oauth_token",
          label: "Codex",
          origin: "~/.codex/auth.json",
          probe: { state: "broken", reason: "The provider rejected this credential." },
        },
      ]),
    )

    expect(statuses.find((harness) => harness.id === "codex")).toMatchObject({
      state: "broken",
      detail: "The provider rejected this credential.",
    })
  })

  test("a settled row is named, never shown as a raw provider id", () => {
    expect(connectionDisplayName("claude-sdk")).toBe("Claude Code login")
    expect(connectionDisplayName("claude-acp")).toBe("Claude Code login")
    expect(connectionDisplayName("openai")).toBe("openai")
  })

  test("keeps two accounts for the same provider independently selectable", () => {
    const preview = aiConnectTransition(
      { phase: "discovering" },
      {
        type: "discovery-succeeded",
        discoveryId: "discovery-1",
        items: [
          {
            providerId: "codex-acp",
            kind: "oauth_token",
            label: "Codex A",
            accountId: "account-a",
            origin: "~/.codex/accounts/a.auth.json",
          },
          {
            providerId: "codex-acp",
            kind: "oauth_token",
            label: "Codex B",
            accountId: "account-b",
            origin: "~/.codex/accounts/b.auth.json",
          },
        ],
      },
    )
    if (preview.phase !== "preview") throw new Error("expected preview")

    const changed = aiConnectTransition(preview, {
      type: "selection-changed",
      selectionId: preview.items[1].selectionId,
      selected: false,
    })
    expect(changed.phase === "preview" && changed.items.map((item) => item.selected)).toEqual([true, false])
  })
})
