/** Opt-in: bun scripts/acp-claude-live-acceptance.ts /absolute/claude-agent-acp [--inspect] */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { AcpHarnessAdapter } from "../src/harnesses/acp/index"
import { SqliteRuntimeStore } from "../src/stores/sqlite"
import { createStdioACPTransport, waitForACPTransportRetirement } from "../src/harnesses/acp/transport"
import type { AgentExecutionBinding } from "@claxedo/agent-runtime-contract"

const command = process.argv[2]
assert(command && path.isAbsolute(command), "Supply an installed Claude ACP executable")
const root = mkdtempSync(path.join(tmpdir(), "claxedo-claude-acp-acceptance-"))
const directory = path.join(root, "workspace")
mkdirSync(directory)
const harness = "acceptance-claude-acp"
const connection = { kind: "process" as const, command, sharedFilesystem: true }
let store = new SqliteRuntimeStore({ root: path.join(root, "store") })
const negotiations: unknown[] = []
const connect = () => new AcpHarnessAdapter({ harness, store, connection, createTransport(input) {
  const transport = createStdioACPTransport(input)
  transport.stream.readable = transport.stream.readable.pipeThrough(new TransformStream({ transform(message, controller) {
    if ("result" in message && message.result && typeof message.result === "object" && "agentCapabilities" in message.result) {
      const result = message.result as { protocolVersion?: unknown; agentCapabilities?: unknown }
      negotiations.push({ protocolVersion: result.protocolVersion, agentCapabilities: result.agentCapabilities })
    }
    controller.enqueue(message)
  } }))
  return transport
} })
let adapter = connect()
function binding(sessionId: string): AgentExecutionBinding {
  const upstreamSessionId = store.getAgentSessionId(sessionId)
  assert(upstreamSessionId)
  return { sessionId, upstreamSessionId, directory, workspaceId: "acceptance", connectionId: harness }
}
try {
  const start = { sessionId: randomUUID(), operationId: randomUUID(), workspaceId: "acceptance", directory, connectionId: harness }
  store.sessionStarts.begin(start)
  assert.equal(store.getSession(start.sessionId), null)
  const session = await adapter.createSession(directory, "Claude ACP acceptance", start.sessionId, { start })
  store.sessionStarts.finish(start, { status: "created", upstreamSessionId: binding(session.id).upstreamSessionId })
  const options = await adapter.probeConfigOptions(directory, binding(session.id))
  const capabilities = await adapter.readHarnessCapabilities(directory, { sessionId: session.id })
  console.log(JSON.stringify({ phase: "negotiated", root, options, capabilities, negotiations }, null, 2))
  if (!process.argv.includes("--inspect")) {
    const modelOption = options.options.find((option) => option.category === "model")
    assert(modelOption?.type === "select" && JSON.stringify(modelOption.options).includes('"value":"sonnet"'), "Previously inspected Sonnet selection must remain advertised")
    const model = { providerID: `connection:${harness}`, modelID: "sonnet" }
    await adapter.updateSessionConfig(binding(session.id), { model, variant: "low" })
    const selected = await adapter.probeConfigOptions(directory, binding(session.id))
    assert.equal(selected.options.find((option) => option.category === "model")?.currentValue, "sonnet")
    assert.equal(selected.options.find((option) => option.id === "effort")?.currentValue, "low")
    const selectedCapabilities = await adapter.readHarnessCapabilities(directory, { sessionId: session.id })
    assert.notEqual(selectedCapabilities.effortLevels.status, "unsupported", "Advertised effort must not be summarized as unsupported")
    const prompt = async (text: string) => {
      const previous = store.getMessages(session.id).length
      const assistantMessageId = randomUUID()
      let idle = false
      for await (const event of adapter.executeTurn(binding(session.id), {
        parts: [{ type: "text", text }], userMessageId: randomUUID(), assistantMessageId, model, variant: "low",
      })) {
        assert.notEqual(event.type, "permission.asked", "The tiny acceptance must not use tools")
        assert.notEqual(event.type, "session.error", JSON.stringify(event))
        idle ||= event.type === "session.idle"
      }
      assert(idle, "Prompt must finish through canonical session.idle")
      // Providers may supply their own authoritative message IDs in updates.
      const messages = store.getMessages(session.id).slice(previous).filter((row) => row.info.role === "assistant")
      assert(messages.length && messages.every((message) => !message.info.error))
      return messages.flatMap((message) => message.parts).filter((part) => part.type === "text").map((part) => part.text).join("")
    }
    const marker = `CLAUDE_ACP_${randomUUID().replaceAll("-", "")}`
    assert((await prompt(`Remember ${marker}. Reply with only that exact marker. Do not use tools or access files.`)).includes(marker))
    const upstream = store.getAgentSessionId(session.id)
    const messages = JSON.stringify(store.getMessages(session.id))
    adapter.dispose()
    store.close()
    store = new SqliteRuntimeStore({ root: path.join(root, "store") })
    assert.equal(JSON.stringify(store.getMessages(session.id)), messages)
    assert.equal(store.sessionStarts.get(session.id)?.status, "created")
    adapter = connect()
    assert((await prompt("What exact marker did I ask you to remember? Reply only with that marker. Do not use tools or access files.")).includes(marker))
    assert.equal(store.getAgentSessionId(session.id), upstream)
    console.log(JSON.stringify({ status: "passed", root, model: "sonnet", effort: "low", prompts: 2,
      checks: ["durable creation owner", "advertised model/effort applied and summarized", "real prompt", "exact SQLite transcript reopen", "agent context resumed", "upstream identity preserved"], negotiations }, null, 2))
  }
} finally {
  adapter.dispose()
  await waitForACPTransportRetirement(process.cwd(), connection)
  store.close()
}
