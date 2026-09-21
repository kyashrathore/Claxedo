// Deterministic ACP peer for public-route and interactive startup acceptance.
// No model, credentials, network requests, or tools are involved.
import { createInterface } from "node:readline"
import { appendFileSync } from "node:fs"

const pending = new Map()
const logFile = process.argv[2]
const send = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n")
const configOptions = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "test", options: [{ value: "test", name: "Deterministic test" }] }]

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (logFile) appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...message }) + "\n")
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "Startup Acceptance", version: "1" }, agentCapabilities: {} } })
  } else if (message.method === "session/new") {
    const id = `form-${message.id}`
    pending.set(id, message.id)
    send({ id, method: "elicitation/create", params: {
      requestId: message.id, mode: "form", message: "Enter a launch label before this session is created.",
      requestedSchema: { type: "object", properties: { label: { type: "string", title: "Launch label" } }, required: ["label"] },
    } })
  } else if (!message.method && pending.has(message.id)) {
    const id = pending.get(message.id)
    pending.delete(message.id)
    if (message.result?.content?.label === "fail") {
      send({ id, error: { code: -32603, message: "Requested startup failure" } })
    } else if (message.result?.action !== "accept") {
      send({ id, error: { code: -32600, message: "Startup was not accepted" } })
    } else {
      send({ id, result: { sessionId: `startup-${process.pid}-${id}`, configOptions } })
    }
  } else if (message.method === "session/prompt") {
    send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Prompt received after startup." } } } })
    send({ id: message.id, result: { stopReason: "end_turn" } })
  } else if (message.id !== undefined && message.method) {
    send({ id: message.id, result: {} })
  }
})
