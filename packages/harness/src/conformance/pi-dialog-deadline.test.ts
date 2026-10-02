import { expect, test } from "bun:test"
import { createRequestBroker, createTurnBroker } from "../broker"
import { MemoryPorts, authority, origin } from "./test-support/memory-ports"
import { ScriptedProcess } from "../test-support/scripted-process"
import { PiRpc, type PiMessage } from "../transports/pi-rpc/rpc"
import { answerPiDialog } from "../transports/pi-rpc/ui"

test("a Pi dialog deadline expires in the broker and sends cancellation on the wire", async () => {
  const ports = new MemoryPorts()
  const owner = createRequestBroker(ports)
  const signal = new AbortController().signal
  const turn = createTurnBroker(owner, { authority, origin, signal })
  const process = new ScriptedProcess<PiMessage>(() => {})
  const rpc = new PiRpc(process.owned(), ports.clock, () => {})
  try {
    const answering = answerPiDialog({ type: "extension_ui_request", method: "confirm", id: "timed-dialog", timeout: 100 },
      rpc, turn, "s1", ports.clock.now(), signal)
    for (let index = 0; index < 12; index++) await Promise.resolve()
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    expect([...ports.timerDelays.values()]).toEqual([100])
    expect(process.received).toHaveLength(0)
    ports.nowValue += 100
    for (const callback of ports.timers.values()) callback()
    await answering
    expect(ports.saved.map((row) => row.answer)).toEqual([{ kind: "expired" }])
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(0)
    expect(process.received).toEqual([{ type: "extension_ui_response", id: "timed-dialog", cancelled: true }])
  } finally { process.exit() }
})
