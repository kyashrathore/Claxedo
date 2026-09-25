import { expect, test } from "bun:test"
import { normalizeWireCorpus } from "./wire-corpus"

test("wire normalization preserves cross-channel identity, state, phase and order", () => {
  const result = normalizeWireCorpus({
    frames: [
      { id: "message.part.updated:ses_11111111:000001_call_aaaaaaaa", phase: "running", observedAt: 1790000000000 },
      { id: "message.part.updated:ses_11111111:000001_call_aaaaaaaa", state: "needs_action" },
    ],
    stored: { sessionID: "ses_11111111", tool: "call_aaaaaaaa", connectionId: "scripted-acp", modelId: "claude-sonnet-4.5", state: "failed", phase: "settled" },
  }) as { frames: Array<{ id: string; phase?: string; state?: string; observedAt?: string }>; stored: { sessionID: string; tool: string; connectionId: string; modelId: string; state: string; phase: string } }
  expect(result.frames[0]?.id).toBe(result.frames[1]?.id)
  expect(result.frames[0]?.id).toContain(result.stored.sessionID)
  expect(result.frames[0]?.id).toContain(result.stored.tool)
  expect(result.frames[0]?.phase).toBe("running")
  expect(result.frames[1]?.state).toBe("needs_action")
  expect(result.stored.state).toBe("failed")
  expect(result.stored.phase).toBe("settled")
  expect(result.stored.connectionId).toBe("scripted-acp")
  expect(result.stored.modelId).toBe("claude-sonnet-4.5")
  expect(result.frames[0]?.observedAt).toBe("<time>")
})

test("wire normalization keeps temporary runtime identities linked", () => {
  const result = normalizeWireCorpus({
    live: { pid: 12345, subagent: "subagent_aaaaaaaa", socket: "/tmp/cc-socks/12345.sock", id: "goal.updated:ses_11111111:1790000000000" },
    stored: { processId: "12345", subagent: "subagent_aaaaaaaa", socket: "/tmp/cc-socks/12345.sock", id: "goal.updated:ses_11111111:1790000000000", error: "Could not read pid 12345: ps -p 12345" },
  }) as { live: { pid: string; subagent: string; socket: string; id: string }; stored: { processId: string; subagent: string; socket: string; id: string; error: string } }
  expect(result.live.pid).toBe(result.stored.processId)
  expect(result.live.subagent).toBe(result.stored.subagent)
  expect(result.live.socket).toBe(result.stored.socket)
  expect(result.live.id).toBe(result.stored.id)
  expect(result.stored.error).toContain(`pid ${result.live.pid}`)
  expect(result.stored.error).toContain(`-p ${result.live.pid}`)
})
