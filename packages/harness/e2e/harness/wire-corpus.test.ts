import { expect, test } from "bun:test"
import { comparisonShape, difference, frameEntity, normalizeWireCorpus } from "./wire-corpus"

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

test("goal event IDs normalize their embedded second timestamps", () => {
  const first = normalizeWireCorpus({ id: "goal.updated:ses_11111111:1790334985" })
  const second = normalizeWireCorpus({ id: "goal.updated:ses_11111111:1790337074" })
  expect(first).toEqual(second)
})

test("frame comparison keeps order inside an entity and accepts cross-entity interleaving", () => {
  const session = (id: string, phase: string) => ({ data: { payload: { type: "session.lifecycle", sessionID: id, phase } } })
  const frames = [session("ses_11111111", "creating"), session("ses_22222222", "creating"),
    session("ses_11111111", "created"), session("ses_22222222", "created")]
  const shaped = (value: unknown[]) => comparisonShape([{ kind: "stream", route: "/events", frames: value }])
  expect(difference(shaped(frames), shaped([frames[1], frames[0], frames[3], frames[2]]))).toBeUndefined()
  expect(difference(shaped(frames), shaped([frames[2], frames[1], frames[0], frames[3]]))).toContain("phase")
  expect(difference(shaped(frames), shaped([frames[0], frames[1], frames[2]]))).toContain("frames")
  const diagnostic = { data: { payload: { type: "runtime.diagnostic", properties: { sessionID: "ses_11111111", code: "unmapped_event" } } } }
  expect(difference(shaped([frames[0], diagnostic]), shaped([diagnostic, frames[0]]))).toContain("type")
  expect(difference(shaped(frames), shaped([{ data: { type: "heartbeat" } }, ...frames]))).toBeUndefined()
  expect(frameEntity(frames[0])).toBe("session:ses_11111111")
})

test("frame comparison keys messages, parts, requests and children separately", () => {
  const frame = (type: string, properties: Record<string, unknown>) => ({ data: { payload: { type, properties } } })
  expect(frameEntity(frame("message.updated", { info: { id: "msg_1" }, sessionID: "ses_1" }))).toBe("message:msg_1")
  expect(frameEntity(frame("message.part.updated", { part: { id: "prt_1" }, sessionID: "ses_1" }))).toBe("part:prt_1")
  expect(frameEntity(frame("permission.asked", { id: "per_1", sessionID: "ses_1" }))).toBe("permission:per_1")
  expect(frameEntity(frame("question.replied", { requestID: "que_1", sessionID: "ses_1" }))).toBe("question:que_1")
  expect(frameEntity(frame("subagent.updated", { update: { sessionID: "ses_child" }, sessionID: "ses_parent" }))).toBe("child:ses_child")
  expect(frameEntity(frame("runtime.diagnostic", { sessionID: "ses_1", code: "unmapped_event" }))).toBe("session:ses_1")
})
