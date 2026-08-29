import { describe, expect, test } from "bun:test"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import {
  clerkSubjectFromIdentity,
  notifySessionShareChanged,
  resolveSessionShareRecipientSubjects,
  type SessionShareChangedSink,
} from "./session-share-fanout"

const aliceAuth = {
  mode: "signed",
  token: "t",
  user: {
    subject: "user_alice",
    tokenIdentifier: "https://issuer.test|user_alice",
    issuer: "https://issuer.test",
  },
} as SignedControlPlaneAuth

describe("clerkSubjectFromIdentity", () => {
  test("extracts Clerk subject from issuer|subject token identifiers", () => {
    expect(clerkSubjectFromIdentity("https://issuer.test|user_bob")).toBe("user_bob")
  })

  test("accepts bare user_ subjects (SQLite list alias)", () => {
    expect(clerkSubjectFromIdentity("user_bob")).toBe("user_bob")
  })

  test("rejects empty and non-subject values", () => {
    expect(clerkSubjectFromIdentity(undefined)).toBeUndefined()
    expect(clerkSubjectFromIdentity("")).toBeUndefined()
    expect(clerkSubjectFromIdentity("not-a-subject")).toBeUndefined()
  })
})

describe("resolveSessionShareRecipientSubjects", () => {
  test("expands a team target via listTeamMembers and excludes the granter", async () => {
    const subjects = await resolveSessionShareRecipientSubjects({
      auth: aliceAuth,
      authority: {
        resolveOrgId: async () => "org_internal",
        listTeamMembers: async () => [
          { token_identifier: "https://issuer.test|user_alice" },
          { token_identifier: "https://issuer.test|user_bob" },
          { clerk_subject: "user_casey" },
        ],
        listTeams: async () => [],
      },
      target: { grantedToTeamPublicId: "team_eng" },
      excludeSubject: "user_alice",
    })
    expect(subjects.sort()).toEqual(["user_bob", "user_casey"])
  })

  test("uses a direct clerk subject for user-targeted grants", async () => {
    const subjects = await resolveSessionShareRecipientSubjects({
      auth: aliceAuth,
      authority: {
        resolveOrgId: async () => "org_internal",
        listTeamMembers: async () => [],
        listTeams: async () => [],
      },
      target: { grantedToClerkSubject: "user_bob" },
      excludeSubject: "user_alice",
    })
    expect(subjects).toEqual(["user_bob"])
  })
})

describe("notifySessionShareChanged", () => {
  test("publishes one doorbell per recipient and survives sink failures", async () => {
    const published: Array<{ ownerUserId: string; phase: string }> = []
    const sink: SessionShareChangedSink = async (event) => {
      if (event.ownerUserId === "user_fail") throw new Error("nudge failed")
      published.push({ ownerUserId: event.ownerUserId, phase: event.phase })
    }
    await notifySessionShareChanged({
      auth: aliceAuth,
      authority: {
        resolveOrgId: async () => "org_internal",
        listTeamMembers: async () => [
          { token_identifier: "https://issuer.test|user_bob" },
          { token_identifier: "https://issuer.test|user_fail" },
          { token_identifier: "https://issuer.test|user_dana" },
        ],
        listTeams: async () => [],
      },
      phase: "granted",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      target: { grantedToTeamPublicId: "team_eng" },
      sink,
    })
    expect(published).toEqual([
      { ownerUserId: "user_bob", phase: "granted" },
      { ownerUserId: "user_dana", phase: "granted" },
    ])
  })

  test("no-ops when sink is absent", async () => {
    await notifySessionShareChanged({
      auth: aliceAuth,
      authority: {
        resolveOrgId: async () => "org_internal",
        listTeamMembers: async () => [{ token_identifier: "https://issuer.test|user_bob" }],
        listTeams: async () => [],
      },
      phase: "revoked",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      target: { grantedToTeamPublicId: "team_eng" },
    })
  })
})
