import fs from "node:fs/promises"
import path from "node:path"
import { writeLineProxyFault } from "./line-proxy-fault"
import { PINNED_PI } from "./pinned-pi"

const BIN_NAME = "pi-rpc-fault-bin"

export async function injectPiRpcFault(dataDir: string) {
  const bin = path.join(dataDir, BIN_NAME)
  const gate = path.join(bin, "armed")
  const evidence = path.join(bin, "seen.log")
  const refusalCommand = process.env.CLAXEDO_E2E_H18_RPC_REFUSAL_RED === "1" ? "command" : JSON.stringify("get_state")
  return writeLineProxyFault({
    dataDir,
    binName: BIN_NAME,
    executableName: "pi.mjs",
    actual: PINNED_PI,
    setup: `import fs from "node:fs"\nconst injected = new Map()`,
    onRequest: `if (request.type === "prompt" && fs.existsSync(${JSON.stringify(gate)})) {
      fs.unlinkSync(${JSON.stringify(gate)})
      injected.set(request.id, request.type)
    }`,
    onReply: `if (injected.has(reply.id)) {
      const command = injected.get(reply.id)
      injected.delete(reply.id)
      process.stdout.write(JSON.stringify({ type: "response", id: "unknown-" + reply.id, command, success: false, error: "H18 unknown id" }) + "\\n")
      process.stdout.write(JSON.stringify({ type: "response", id: reply.id, command: ${refusalCommand}, success: false, error: "H18 mismatched command" }) + "\\n")
      fs.appendFileSync(${JSON.stringify(evidence)}, "injected " + reply.id + "\\nreal " + reply.id + "\\n")
    }`,
  })
}

export async function armPiRpcFault(dataDir: string) {
  await fs.writeFile(path.join(dataDir, BIN_NAME, "armed"), "")
}

export async function piRpcFaultEvidence(dataDir: string) {
  return fs.readFile(path.join(dataDir, BIN_NAME, "seen.log"), "utf8")
}
