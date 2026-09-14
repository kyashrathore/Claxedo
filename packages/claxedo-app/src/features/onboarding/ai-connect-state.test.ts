import { describe, expect, test } from "bun:test"
import {
  aiConnectFailureCopy,
  aiConnectTransition,
  connectionDisplayName,
  destinationStoresCredentials,
  discoveryRows,
  initialAIConnectState,
  localHarnessChecks,
  localHarnessStatuses,
  isUsableResult,
} from "./ai-connect-state"
import { HARNESS_TABLE } from "@claxedo/agent-runtime-contract"

const claudeToken = [
  {
    providerId: "claude-sdk",
    kind: "oauth_token",
    label: "Synced from CLAUDE_CODE_OAUTH_TOKEN",
    origin: "Environment variable CLAUDE_CODE_OAUTH_TOKEN",
  },
]

describe("AI connect state", () => {
  test("settles with every credential's own verdict", () => {
    const saved = aiConnectTransition(initialAIConnectState(), { type: "save-started" })
    expect(saved.phase).toBe("saving")

    const results = [
      { credentialId: "c1", providerId: "anthropic", result: "ok" as const },
      { credentialId: "c2", providerId: "codex-app-server", result: "expired" as const },
    ]
    expect(aiConnectTransition(saved, { type: "settled", results })).toEqual({ phase: "settled", results })
  })

  test("a failing credential no longer hides the ones that worked", () => {
    // The old reduction took the first non-ok result and returned early, so a
    // batch where three of four verified was reported as a total failure.
    const settled = aiConnectTransition({ phase: "saving" }, {
      type: "settled",
      results: [
        { credentialId: "c1", providerId: "anthropic", result: "expired" },
        { credentialId: "c2", providerId: "anthropic", result: "ok" },
        { credentialId: "c3", providerId: "openai", result: "ok" },
      ],
    })

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
      items: [{ providerId: "anthropic", kind: "oauth_token", label: "Claude subscription", origin: "Environment variable CLAUDE_CODE_OAUTH_TOKEN" }],
    })

    expect(preview).toMatchObject({ phase: "preview", discoveryId: "discovery-1" })
    expect(preview.phase === "preview" && preview.items[0].selected).toBe(true)
  })

  test("a local-only run lands on what the harnesses reported, with nothing to commit", () => {
    // The whole point of A0: nothing to commit, so there is no discovery id to
    // commit it against and no checkbox implying there is a choice to make.
    const confirmed = aiConnectTransition({ phase: "discovering" }, {
      type: "machine-logins-read",
      logins: [{ harness: "claude", providerIds: ["claude-acp", "claude-sdk"], state: "signed_in", email: "person@acme.com" }],
    })

    expect(confirmed.phase).toBe("confirmed")
    expect(confirmed.phase === "confirmed" && confirmed.logins.map((login) => login.email)).toEqual(["person@acme.com"])
    expect(JSON.stringify(confirmed)).not.toContain("discovery-1")
  })

  test.each(["cloud", "both"] as const)("a %s destination still collects, because a sandbox has no login of its own", (destination) => {
    const state = aiConnectTransition({ phase: "discovering" }, {
      type: "discovery-succeeded",
      discoveryId: "discovery-1",
      items: claudeToken,
    })

    expect(state).toMatchObject({ phase: "preview", discoveryId: "discovery-1" })
    expect(destinationStoresCredentials(destination)).toBe(true)
  })

  test("an unset destination collects exactly as before, so the flow that has no question yet is unchanged", () => {
    const state = aiConnectTransition({ phase: "discovering" }, {
      type: "discovery-succeeded",
      discoveryId: "discovery-1",
      items: claudeToken,
    })

    expect(state.phase).toBe("preview")
  })

  test("only a local destination declines to store", () => {
    expect(destinationStoresCredentials("local")).toBe(false)
    expect(destinationStoresCredentials("cloud")).toBe(true)
    expect(destinationStoresCredentials("both")).toBe(true)
  })

  test("one discovered login is one row, saved under the provider it arrived as", () => {
    const rows = discoveryRows(claudeToken)

    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe("Synced from CLAUDE_CODE_OAUTH_TOKEN")
    expect(rows[0].providerId).toBe("claude-sdk")
  })

  test("two Codex accounts stay two rows — different accounts are different credentials", () => {
    const rows = discoveryRows([
      { providerId: "codex-app-server", kind: "oauth_token", label: "Synced from local Codex auth", accountId: "account…a", origin: "Synced from OPENAI_API_KEY" },
      { providerId: "codex-app-server", kind: "oauth_token", label: "Synced from local Codex auth", accountId: "account…b", origin: "~/.codex/accounts/b.auth.json" },
    ])

    expect(rows.map((row) => row.accountId)).toEqual(["account…a", "account…b"])
    expect(new Set(rows.map((row) => row.selectionId)).size).toBe(2)
  })

  test("a row the provider rejected is shown with its reason and left unchecked", () => {
    const rows = discoveryRows([
      { ...claudeToken[0], probe: { state: "broken", reason: "The provider rejected this credential." } },
    ])

    expect(rows[0].probe).toEqual({ state: "broken", reason: "The provider rejected this credential." })
    expect(rows[0].selected).toBe(false)
  })

  test("an already-connected row is not offered again", () => {
    const rows = discoveryRows([{ ...claudeToken[0], alreadyConnected: true, probe: { state: "working" } }])

    expect(rows[0].alreadyConnected).toBe(true)
    expect(rows[0].selected).toBe(false)
  })


  test("a row lists every binding the server stores a login for, never a subset of its own", () => {
    // The Cursor row once named `cursor-acp` alone while the server stored its
    // sign-in under `cursor-sdk`, so a stored Cursor account had no row.
    expect(localHarnessChecks.map((check) => [check.id, check.providerIds, check.connectProvider])).toEqual(
      (["claude", "codex", "cursor"] as const).map((harness) =>
        [harness, HARNESS_TABLE[harness].providerIds, HARNESS_TABLE[harness].connectProvider]),
    )
  })

  test("every harness the local checks name gets a row, whatever the reports contain", () => {
    const statuses = localHarnessStatuses([
      { harness: "claude", providerIds: ["claude-acp", "claude-sdk"], state: "signed_in", email: "person@acme.com", plan: "max" },
    ])

    expect(statuses.map((harness) => harness.id)).toEqual(["claude", "codex", "cursor"])
    expect(statuses.map((harness) => harness.state)).toEqual(["signed_in", "absent", "absent"])
    expect(statuses[0]).toMatchObject({ label: "Claude Code", signIn: "claude", email: "person@acme.com", plan: "max" })
  })

  test("a harness's own answer rides along whole: its quota windows, and why it could not be asked", () => {
    const statuses = localHarnessStatuses([
      {
        harness: "codex",
        providerIds: ["codex-app-server", "openai"],
        state: "signed_in",
        usage: [{ window: "weekly", usedPercent: 64, resetsAt: 1_757_700_000_000 }],
      },
      { harness: "cursor", providerIds: ["cursor-acp"], state: "unknown", detail: "Cursor did not answer with a login status." },
    ])

    expect(statuses.find((harness) => harness.id === "codex")).toMatchObject({
      state: "signed_in",
      usage: [{ window: "weekly", usedPercent: 64, resetsAt: 1_757_700_000_000 }],
    })
    expect(statuses.find((harness) => harness.id === "cursor")).toMatchObject({
      state: "unknown",
      detail: "Cursor did not answer with a login status.",
    })
  })

  test("signed out and not installed stay apart, because the repair differs", () => {
    const statuses = localHarnessStatuses([
      { harness: "claude", providerIds: ["claude-acp", "claude-sdk"], state: "signed_out" },
      { harness: "codex", providerIds: ["codex-app-server", "openai"], state: "absent" },
    ])

    expect(statuses.map((harness) => harness.state)).toEqual(["signed_out", "absent", "absent"])
  })

  test("a settled row is named, never shown as a raw provider id", () => {
    expect(connectionDisplayName("claude-sdk")).toBe("Claude Code login")
    expect(connectionDisplayName("claude-acp")).toBe("Claude Code login")
    expect(connectionDisplayName("openai")).toBe("openai")
  })

  test("keeps two accounts for the same provider independently selectable", () => {
    const preview = aiConnectTransition({ phase: "discovering" }, {
      type: "discovery-succeeded",
      discoveryId: "discovery-1",
      items: [
        { providerId: "codex-app-server", kind: "oauth_token", label: "Codex A", accountId: "account-a", origin: "~/.codex/accounts/a.auth.json" },
        { providerId: "codex-app-server", kind: "oauth_token", label: "Codex B", accountId: "account-b", origin: "~/.codex/accounts/b.auth.json" },
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
