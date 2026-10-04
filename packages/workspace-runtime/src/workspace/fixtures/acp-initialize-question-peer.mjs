import readline from "node:readline"
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
let initialize
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line)
  if (message.method === "initialize") {
    initialize = message.id
    send({ id: 201, method: "elicitation/create", params: { requestId: message.id, mode: "form", message: "Choose workspace label", requestedSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } } })
  } else if (message.id === 201 && message.result) {
    if (message.result.action !== "accept") send({ id: initialize, error: { code: -32603, message: "User declined initialization" } })
    else send({ id: initialize, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  } else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "upstream-started" } })
  else if (message.method && "id" in message) send({ id: message.id, error: { code: -32601, message: "Unexpected session operation" } })
})
