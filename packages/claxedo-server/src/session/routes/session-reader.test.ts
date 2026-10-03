import { describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { SessionReaderState } from "@claxedo/agent-runtime-contract"
import { createSessionReaderRoutes } from "./session-reader"

const auth = { mode: "signed", token: "token", user: { subject: "usr_alice", tokenIdentifier: "canonical|usr_alice", issuer: "canonical" },
  principal: { userId: "usr_alice" } } as SignedControlPlaneAuth
const state: SessionReaderState = { generation: 1, revision: 1, seenThrough: 10 }
const command = { kind: "seen", generation: 1, outcomeSequence: 10 }
const request = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

describe("session reader route", () => {
  test("emits confirmed reader state only to that user's canonical account room", async () => {
    const notice = vi.fn(async () => undefined)
    const writeSessionReader = vi.fn(async () => ({ ok: true as const, state }))
    const app = createSessionReaderRoutes({ authenticate: async () => auth, notice, now: () => 100,
      authority: { writeSessionReader, listSessionStateNotices: async () => [{ sessionId: "s", workspaceId: "w", projectId: "p", orgId: "o",
        attention: { generation: 1, sequence: 10, activitySequence: 10, activityAt: 50, working: false, awaitingInput: false },
        status: { kind: "idle", awaitingInput: false, at: 50 }, recipients: [{ userId: "usr_alice" }, { userId: "usr_bob" }] }] } })
    const response = await app.request("http://test/sessions/s/reader?workspaceId=w", request(command))
    expect(response.status).toBe(200)
    expect(writeSessionReader).toHaveBeenCalledWith(auth, { sessionId: "s", workspaceId: "w", command })
    expect(notice).toHaveBeenCalledTimes(1)
    expect(notice).toHaveBeenCalledWith({ type: "session.reader.changed", ownerUserId: "usr_alice", sessionId: "s", workspaceId: "w", projectId: "p", orgId: "o", reader: state, ts: 100 })
  })

  test("rejects malformed requests before mutating and never announces a conflicting mutation", async () => {
    const notice = vi.fn(async () => undefined)
    const writeSessionReader = vi.fn(async () => ({ ok: false as const, reason: "reader_changed" as const }))
    const app = createSessionReaderRoutes({ authenticate: async () => auth, notice, authority: { writeSessionReader, listSessionStateNotices: async () => [] } })
    expect((await app.request("http://test/sessions/s/reader", request(command))).status).toBe(400)
    expect((await app.request("http://test/sessions/s/reader?workspaceId=w", request({ ...command, outcomeSequence: -1 }))).status).toBe(400)
    expect(writeSessionReader).not.toHaveBeenCalled()
    expect((await app.request("http://test/sessions/s/reader?workspaceId=w", request(command))).status).toBe(409)
    expect(notice).not.toHaveBeenCalled()
  })
})
