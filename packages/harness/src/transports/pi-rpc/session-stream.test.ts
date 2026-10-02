import { expect, test } from "bun:test"
import type { ProviderTurnInput, SessionBroker, TurnBroker } from "../../contract"
import { ScriptedProcess } from "../../test-support/scripted-process"
import { PiRpc } from "./rpc"
import { PiRun } from "./run"
import { PiSessionStream } from "./session-stream"

test.each(["handled", "started"])("a %s reply assigns the next Pi run in wire order within the same read", async (disposition) => {
  const wire = new ScriptedProcess<{ id: string; type: string }>(() => {})
  const clock = { now: Date.now, setTimeout, clearTimeout }
  const rpc = new PiRpc(wire.owned(), clock, () => {})
  const inputs: ProviderTurnInput[] = []
  const broker = { admitProviderTurn: async (input: ProviderTurnInput) => {
    inputs.push(input)
    return { admitted: false, reason: "test refuses provider admission" }
  } } as unknown as SessionBroker
  const stream = new PiSessionStream({ sessionId: "s1", rpc, broker, clock, stop: async () => {},
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } })
  const run = new PiRun(rpc, "s1", clock, {} as TurnBroker)
  const release = stream.claim(run)
  const reply = rpc.request("prompt", { message: "/later" })
  const request = wire.received[0]!
  wire.stdout.write([
    { type: "response", id: request.id, command: "prompt", success: true, data: { disposition } },
    { type: "agent_start" },
    { type: "message_start", message: { role: "user", content: [{ type: "text", text: "Pi's own prompt" }] } },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n")
  try {
    expect(run.settled).toBe(disposition === "handled")
    expect(run.started).toBe(disposition === "started")
    expect(stream.run).toBe(disposition === "handled" ? undefined : run)
    expect(inputs).toEqual(disposition === "handled" ? [{ reason: "provider", detail: "Pi's own prompt" }] : [])
    expect(await reply).toEqual({ disposition })
  } finally { release(); wire.exit() }
})
