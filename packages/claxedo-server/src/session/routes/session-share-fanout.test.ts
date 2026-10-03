import { describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { OrgId } from "@claxedo/server-core/platform/auth/branded-id"
import { notifySessionShareChanged } from "../session-people-contract"

const aliceAuth = {
  mode: "signed",
  token: "t",
  user: { subject: "usr_alice", tokenIdentifier: "https://issuer.test|alice", issuer: "https://issuer.test" },
} as SignedControlPlaneAuth

const authority = { resolveOrgId: async () => "org_internal" as OrgId }

async function doorbells(recipientUserIds: readonly string[], sink?: (ownerUserId: string) => void) {
  const rung: Array<{ ownerUserId: string; phase: string; level?: string; orgId?: string }> = []
  await notifySessionShareChanged({
    auth: aliceAuth,
    authority,
    phase: "granted",
    level: "send",
    sessionId: "ses_1",
    workspaceId: "ws_1",
    recipientUserIds,
    sink: async (event) => {
      sink?.(event.ownerUserId)
      rung.push({ ownerUserId: event.ownerUserId, phase: event.phase, ...(event.phase === "granted" ? { level: event.level } : {}), ...(event.orgId ? { orgId: event.orgId } : {}) })
    },
  })
  return rung
}

describe("notifySessionShareChanged", () => {
  test("rings each canonical user the share named once, never the granter", async () => {
    expect(await doorbells(["usr_bob", "usr_alice", "usr_bob", "usr_dana"])).toEqual([
      { ownerUserId: "usr_bob", phase: "granted", level: "send", orgId: "org_internal" },
      { ownerUserId: "usr_dana", phase: "granted", level: "send", orgId: "org_internal" },
    ])
  })

  test("keeps ringing the others when one doorbell fails", async () => {
    const rung = await doorbells(["usr_bob", "usr_dana"], (ownerUserId) => { if (ownerUserId === "usr_bob") throw new Error("nudge failed") })
    expect(rung.map((row) => row.ownerUserId)).toEqual(["usr_dana"])
  })

  test("no-ops when sink is absent", async () => {
    await expect(notifySessionShareChanged({
      auth: aliceAuth,
      authority,
      phase: "revoked",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      recipientUserIds: ["usr_bob"],
    })).resolves.toBeUndefined()
  })
})
