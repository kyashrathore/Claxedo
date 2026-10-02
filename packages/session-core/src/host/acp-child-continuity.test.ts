import { expect, test } from "bun:test"
import { wireFixture, reached } from "../../../harness/src/conformance/test-support/acp-wire"
import { createHostFixture, sessionCreate, LOOPBACK_ORIGIN, until } from "../test-support/host-fixture"

test("ACP child output crosses parent completion and the next turn before its own completion releases its lease", async () => {
  const wire = wireFixture((peer, message) => {
    if (message.method !== "initialize") return message.method === "session/prompt" && peer.messages.filter(row => row.method === "session/prompt").length <= 2
    peer.reply(message, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } },
      _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } } })
    return true
  })
  const host = createHostFixture({ transports: { c1: wire.transport } })
  try {
    await host.runtime.sessions.create({ ...sessionCreate({ id: "parent", harness: { id: "c1", access: "connection" } }), model: { providerID: "c1", modelID: "one" } })
    await host.runtime.turns.start({ sessionId: "parent", text: "work", origin: LOOPBACK_ORIGIN })
    const peer = wire.peers.at(-1)!
    const prompt = await reached(() => peer.messages.find(row => row.method === "session/prompt"))
    const parent = prompt.params!.sessionId as string
    const send = (update: unknown) => peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: parent, update } })
    send({ sessionUpdate: "subagent_spawned", subagentSessionId: "child", name: "review", task: "review code" })
    await until(() => host.store.listSubagents("parent").length === 1)
    const child = host.store.listSubagents("parent")[0].childSessionId!
    const lease = host.store.readTurnAuthority(child)?.leaseId
    expect(lease).toBeString()
    peer.reply(prompt, { stopReason: "end_turn" })
    ;(await host.runtime.turns.whenIdle("parent")).abandon()
    expect(host.store.readTurnAuthority(child)?.leaseId).toBe(lease)
    peer.text("child", "after parent completion")
    await until(() => JSON.stringify(host.store.getMessages(child)).includes("after parent completion"))
    await host.runtime.turns.start({ sessionId: "parent", text: "follow up", origin: LOOPBACK_ORIGIN })
    const next = await reached(() => peer.messages.filter(row => row.method === "session/prompt")[1])
    peer.text("child", " during next turn")
    send({ sessionUpdate: "subagent_state_update", subagentSessionId: "child", state: "completed" })
    await until(() => host.store.getSession(child)?.lastTurn?.status === "completed")
    expect(JSON.stringify(host.store.getMessages(child))).toContain("during next turn")
    expect(host.store.readTurnAuthority(child)).toBeUndefined()
    expect(JSON.stringify(host.store.getMessages("parent"))).not.toContain("after parent completion")
    peer.reply(next, { stopReason: "end_turn" })
    ;(await host.runtime.turns.whenIdle("parent")).abandon()
  } finally { await host.dispose() }
})
