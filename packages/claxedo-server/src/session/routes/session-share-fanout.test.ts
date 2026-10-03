import { describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { OrgId } from "@claxedo/server-core/platform/auth/branded-id"
import { notifySessionShareChanged, resolveSessionShareRecipientUserIds } from "../session-people-contract"

const auth = { mode: "signed", token: "t", user: { subject: "usr_alice", tokenIdentifier: "canonical|usr_alice", issuer: "canonical" } } as SignedControlPlaneAuth
const target = { grantedToTokenIdentifier: "https://provider.test|provider_bob" }

describe("canonical session share recipient fanout", () => {
  test("uses only authority-resolved user IDs and excludes the granter", async () => {
    const resolveSessionShareRecipients = vi.fn(async () => ["usr_alice", "usr_bob", "usr_bob"])
    const users = await resolveSessionShareRecipientUserIds({ auth, authority: { resolveSessionShareRecipients },
      sessionId: "s", workspaceId: "w", target, excludeUserId: "usr_alice" })
    expect(users).toEqual(["usr_bob"])
    expect(resolveSessionShareRecipients).toHaveBeenCalledWith(auth, { sessionId: "s", workspaceId: "w", target })
  })

  test("publishes every canonical target despite an individual sink failure", async () => {
    const received: string[] = []
    await notifySessionShareChanged({ auth, authority: { resolveOrgId: async () => "o" as OrgId,
      resolveSessionShareRecipients: async () => ["usr_bob", "usr_failed", "usr_dana"] },
      phase: "revoked", sessionId: "s", workspaceId: "w", target,
      sink: async (event) => { if (event.ownerUserId === "usr_failed") throw new Error("nudge failed"); received.push(event.ownerUserId) } })
    expect(received).toEqual(["usr_bob", "usr_dana"])
  })

  test("an unresolved canonical target never falls back to a provider subject", async () => {
    const sink = vi.fn()
    await notifySessionShareChanged({ auth, authority: { resolveOrgId: async () => "o" as OrgId,
      resolveSessionShareRecipients: async () => [] }, phase: "revoked", sessionId: "s", workspaceId: "w", target, sink })
    expect(sink).not.toHaveBeenCalled()
  })
})
