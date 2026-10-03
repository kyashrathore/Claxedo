import { describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { OrgId } from "@claxedo/server-core/platform/auth/branded-id"
import type { SessionShareFanoutTarget } from "@claxedo/server-core/platform/auth/authority"
import { subjectFromIdentity, notifySessionShareChanged } from "../session-people-contract"

const aliceAuth = {
  mode: "signed",
  token: "t",
  user: {
    subject: "user_alice",
    tokenIdentifier: "https://issuer.test|user_alice",
    issuer: "https://issuer.test",
  },
} as SignedControlPlaneAuth

describe("subjectFromIdentity", () => {
  test("extracts the subject from issuer|subject token identifiers", () => {
    expect(subjectFromIdentity("https://issuer.test|user_bob")).toBe("user_bob")
  })

  test("accepts bare user_ subjects (SQLite list alias)", () => {
    expect(subjectFromIdentity("user_bob")).toBe("user_bob")
  })

  test("rejects empty and non-subject values", () => {
    expect(subjectFromIdentity(undefined)).toBeUndefined()
    expect(subjectFromIdentity("")).toBeUndefined()
    expect(subjectFromIdentity("not-a-subject")).toBeUndefined()
  })
})

const authority = { resolveOrgId: async () => "org_internal" as OrgId }

async function doorbells(target: SessionShareFanoutTarget, sink?: (ownerUserId: string) => void) {
  const rung: Array<{ ownerUserId: string; phase: string; level?: string; orgId?: string }> = []
  await notifySessionShareChanged({
    auth: aliceAuth,
    authority,
    phase: "granted",
    level: "send",
    sessionId: "ses_1",
    workspaceId: "ws_1",
    target,
    sink: async (event) => {
      sink?.(event.ownerUserId)
      rung.push({ ownerUserId: event.ownerUserId, phase: event.phase, ...(event.phase === "granted" ? { level: event.level } : {}), ...(event.orgId ? { orgId: event.orgId } : {}) })
    },
  })
  return rung
}

describe("notifySessionShareChanged", () => {
  test("rings the person a share names", async () => {
    expect(await doorbells({ grantedToTokenIdentifier: "https://issuer.test|user_bob" }))
      .toEqual([{ ownerUserId: "user_bob", phase: "granted", level: "send", orgId: "org_internal" }])
  })

  test("never rings the granter or a target that names no person", async () => {
    expect(await doorbells({ grantedToSubject: "user_alice" })).toEqual([])
    expect(await doorbells({ grantedToTokenIdentifier: "not-a-subject" })).toEqual([])
  })

  test("keeps a completed share mutation successful when the sink fails", async () => {
    await expect(doorbells({ grantedToUserId: "user_bob" }, () => { throw new Error("nudge failed") })).resolves.toEqual([])
  })

  test("no-ops when sink is absent", async () => {
    await expect(notifySessionShareChanged({
      auth: aliceAuth,
      authority,
      phase: "revoked",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      target: { grantedToUserId: "user_bob" },
    })).resolves.toBeUndefined()
  })
})
