import { expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { SessionStateNotice } from "@claxedo/server-core/platform/auth/session-attention-authority"
import type { ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { notifySessionReaderChanged } from "./notify-session-state"

const notice: SessionStateNotice = {
  sessionId: "ses", workspaceId: "ws", orgId: "org", projectId: "project",
  attention: { generation: 1, sequence: 3, activitySequence: 2, activityAt: 2, working: false, awaitingInput: false },
  status: { kind: "idle", awaitingInput: false, at: 3 },
  recipients: [{ userId: "alice" }, { userId: "bob" }],
}
const auth = { mode: "signed", principal: { userId: "alice" } } as SignedControlPlaneAuth

test("reader notices reach the same reader's linked devices and carry canonical project identity", async () => {
  const sink = vi.fn(async (_event: ControlPlaneEvent) => undefined)
  const reader = { generation: 1, revision: 1, seenThrough: 2, seenAt: 4 }
  await notifySessionReaderChanged({ auth, authority: { listSessionStateNotices: async () => [notice] },
    ref: notice, reader, sink, now: 4 })
  expect(sink.mock.calls.map(([event]) => event)).toEqual([
    { type: "session.reader.changed", ownerUserId: "alice", orgId: "org", projectId: "project", sessionId: "ses", workspaceId: "ws", reader, ts: 4 },
  ])
})

test("a reader notice carries no title, outcome or Working entrant metadata", async () => {
  const sink = vi.fn(async (_event: ControlPlaneEvent) => undefined)
  const rich: SessionStateNotice = { ...notice, title: "Private title", lastTurn: { status: "completed", completedAt: 1 },
    attention: { ...notice.attention, working: true },
    status: { kind: "busy", awaitingInput: false, at: 3 } }
  await notifySessionReaderChanged({ auth, authority: { listSessionStateNotices: async () => [rich] },
    ref: notice, reader: { generation: 1, revision: 1, seenThrough: 2 }, sink, now: 4 })
  expect(sink.mock.calls[0][0]).toEqual({ type: "session.reader.changed", ownerUserId: "alice", orgId: "org",
    projectId: "project", sessionId: "ses", workspaceId: "ws", reader: { generation: 1, revision: 1, seenThrough: 2 }, ts: 4 })
})

test("does not swallow delivery failure or fabricate notice identity when the owner is unavailable", async () => {
  const reader = { generation: 1, revision: 1, seenThrough: 2 }
  const input = { auth, authority: { listSessionStateNotices: async () => [notice] }, ref: notice, reader, now: 4 }
  await expect(notifySessionReaderChanged({ ...input, sink: async () => { throw new Error("Room write failed") } })).rejects.toThrow("Room write failed")
  const sink = vi.fn(async () => undefined)
  await expect(notifySessionReaderChanged({ ...input, authority: {}, sink })).rejects.toThrow("notifications are unavailable")
  expect(sink).not.toHaveBeenCalled()
})
