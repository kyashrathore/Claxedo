// Deterministic external ACP peer for restart and missing-history acceptance.
import { createInterface } from "node:readline"
import { appendFileSync, existsSync } from "node:fs"
const [logFile, recovery] = process.argv.slice(2)
let pendingPrompt
const send = body => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n")
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line)
  appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...message }) + "\n")
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: recovery === "unsupported" ? {} : { sessionCapabilities: { resume: {} } } } })
  } else if (message.method === "session/new") {
    send({ id: message.id, result: { sessionId: `upstream-${process.pid}-${message.id}` } })
  } else if (message.method === "session/resume") {
    if (recovery === "missing") send({ id: message.id, error: { code: -32002, message: "Session missing", data: { sessionId: message.params.sessionId } } })
    else if (recovery === "auth") send({ id: message.id, error: { code: -32000, message: "Authentication required" } })
    else send({ id: message.id, result: {} })
  } else if (message.method === "session/prompt") {
    send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Persisted recovery-peer answer." } } } })
    if (recovery === "cancel" && message.params.prompt.some(part => part.text === "Wait for cancellation.")) {
      pendingPrompt = message
      return
    }
    if (recovery === "approval" && message.params.prompt.some(part => part.text === "Wait for approval.")) {
      send({ id: "approval-rpc", method: "session/request_permission", params: { sessionId: message.params.sessionId,
        toolCall: { toolCallId: "waiting-tool", title: "echo approval-fixture", kind: "execute", status: "pending", rawInput: { command: "echo approval-fixture" } },
        options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } })
      return
    }
    send({ id: message.id, result: { stopReason: "end_turn" } })
  } else if (message.method === "session/cancel" && pendingPrompt?.params.sessionId === message.params.sessionId) {
    const original = pendingPrompt
    const release = setInterval(() => {
      if (!existsSync(logFile + ".release")) return
      clearInterval(release)
      send({ method: "session/update", params: { sessionId: original.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Late output after cancellation." } } } })
      send({ id: original.id, result: { stopReason: "end_turn" } })
      pendingPrompt = undefined
    }, 10)
  } else if (message.method && message.id !== undefined) send({ id: message.id, result: {} })
})
