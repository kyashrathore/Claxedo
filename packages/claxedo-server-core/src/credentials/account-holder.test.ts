import { describe, expect, test } from "vitest"
import { selectSessionCredentials } from "@claxedo/harness/registry"
import { LOCAL_USER_ID } from "../platform/auth/local-identity"
import { selectedAccounts, spendsAccount, TEAM_ACCOUNT_UNAVAILABLE, type AccountSelections } from "./account-holder"

const own = (person: string) => ({ baseUrl: `https://${person}.example`, placeholder: person, authMode: "api-key" as const })
const TEAM = own("team")
const unavailable = { unavailable: true as const, reason: TEAM_ACCOUNT_UNAVAILABLE }

function snapshot(selections: AccountSelections, rows: Array<{ owner: string | null; providerId: string; projection: ReturnType<typeof own> | typeof unavailable }>) {
  return {
    machineOwnerUserId: "alice",
    accounts: selectedAccounts({ machineOwnerUserId: "alice", rows, selections, missingTeam: () => unavailable }),
  }
}

function session(input: ReturnType<typeof snapshot>, userId: string) {
  return selectSessionCredentials({
    ...input, placement: "desktop", canUseOwnLogin: true, leaseGeneration: "g", providerIds: ["openai"],
  }, { kind: "person", userId })
}

describe("the one account rule", () => {
  test("choosing the team account spends it, and nobody who did not choose it sees it", () => {
    const answer = snapshot({ bob: { openai: "team" } }, [
      { owner: "bob", providerId: "openai", projection: own("bob") },
      { owner: null, providerId: "openai", projection: TEAM },
    ])
    expect(session(answer, "bob").providers).toEqual({ openai: TEAM })
    expect(answer.accounts.carol).toBeUndefined()
  })

  test("choosing their own spends their own, even with a team account on offer", () => {
    const answer = snapshot({ bob: { openai: "own" } }, [
      { owner: "bob", providerId: "openai", projection: own("bob") },
      { owner: null, providerId: "openai", projection: TEAM },
    ])
    expect(session(answer, "bob").providers).toEqual({ openai: own("bob") })
  })

  test("a chosen team account that is revoked or missing refuses rather than falling back to the person's own", () => {
    const revoked = snapshot({ bob: { openai: "team" } }, [
      { owner: "bob", providerId: "openai", projection: own("bob") },
      { owner: null, providerId: "openai", projection: { unavailable: true, reason: "revoked" } as never },
    ])
    expect(() => session(revoked, "bob")).toThrow("revoked")
    const missing = snapshot({ bob: { openai: "team" } }, [{ owner: "bob", providerId: "openai", projection: own("bob") }])
    expect(() => session(missing, "bob")).toThrow(TEAM_ACCOUNT_UNAVAILABLE)
  })

  test("a revoked own account refuses rather than falling back to the team's", () => {
    const answer = snapshot({}, [
      { owner: "bob", providerId: "openai", projection: { unavailable: true, reason: "revoked" } as never },
      { owner: null, providerId: "openai", projection: TEAM },
    ])
    expect(() => session(answer, "bob")).toThrow("revoked")
  })

  test("the machine owner's own login is never beaten by a team account they did not choose", () => {
    const answer = snapshot({}, [{ owner: null, providerId: "openai", projection: TEAM }])
    expect(session(answer, "alice")).toMatchObject({ providers: {}, machineLoginAllowed: true })
    expect(() => session(answer, "bob")).toThrow()
  })

  test("the loopback operator's choice is the machine owner's", () => {
    const answer = snapshot({ [LOCAL_USER_ID]: { openai: "team" } }, [
      { owner: LOCAL_USER_ID, providerId: "openai", projection: own("alice") },
      { owner: null, providerId: "openai", projection: TEAM },
    ])
    expect(session(answer, "alice").providers).toEqual({ openai: TEAM })
  })

  test("delivery reads the same rule: only the chosen row of each provider is spent", () => {
    const rows = [
      { owner: "bob", provider_id: "openai" },
      { owner: null, provider_id: "openai" },
      { owner: "carol", provider_id: "openai" },
      { owner: null, provider_id: "anthropic" },
    ]
    expect(rows.filter((row) => spendsAccount(row, "bob", { openai: "team" }, "alice"))).toEqual([{ owner: null, provider_id: "openai" }])
    expect(rows.filter((row) => spendsAccount(row, "bob", {}, "alice"))).toEqual([{ owner: "bob", provider_id: "openai" }])
  })
})
