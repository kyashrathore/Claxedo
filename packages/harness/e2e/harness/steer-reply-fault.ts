import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { PINNED_PI } from "./pinned-pi"

export async function withholdSteerReply(dataDir: string, harness: "pi" | "codex") {
  const bin = path.join(dataDir, `${harness}-steer-fault-bin`)
  const actual = harness === "pi" ? PINNED_PI : execFileSync("which", ["codex"], { encoding: "utf8" }).trim()
  const node = process.env.CLAXEDO_E2E_NODE
  if (!node) throw new Error("The steer reply fault needs CLAXEDO_E2E_NODE")
  await fs.mkdir(bin)
  const gate = path.join(bin, "withhold")
  if (process.env.CLAXEDO_E2E_H7_UNKNOWN_PASSTHROUGH !== "1") await fs.writeFile(gate, "")
  const executable = path.join(bin, harness === "pi" ? "pi.mjs" : "codex")
  const script = `#!${node}
import { spawn } from "node:child_process"
import fs from "node:fs"
const child = spawn(${JSON.stringify(actual)}, process.argv.slice(2), { env: process.env, stdio: ["pipe", "pipe", "inherit"] })
const versionMode = process.argv.includes("--version")
const withheld = new Set()
let incoming = ""
let outgoing = ""
process.stdin.on("data", (chunk) => {
  incoming += chunk.toString()
  let end
  while ((end = incoming.indexOf("\\n")) >= 0) {
    const line = incoming.slice(0, end)
    incoming = incoming.slice(end + 1)
    const request = JSON.parse(line)
    if ((request.method === "turn/steer" || request.type === "steer") && fs.existsSync(${JSON.stringify(gate)})) {
      withheld.add(request.id)
      fs.appendFileSync(${JSON.stringify(path.join(bin, "seen.log"))}, "steer " + line + "\\n")
    }
  }
  child.stdin.write(chunk)
})
child.stdout.on("data", (chunk) => {
  if (versionMode) { process.stdout.write(chunk); return }
  outgoing += chunk.toString()
  let end
  while ((end = outgoing.indexOf("\\n")) >= 0) {
    const line = outgoing.slice(0, end)
    outgoing = outgoing.slice(end + 1)
    const reply = JSON.parse(line)
    if (withheld.delete(reply.id)) {
      fs.appendFileSync(${JSON.stringify(path.join(bin, "seen.log"))}, "reply withheld\\n")
    } else process.stdout.write(line + "\\n")
  }
})
process.on("SIGTERM", () => child.kill("SIGTERM"))
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1))
`
  await fs.writeFile(executable, script, { mode: 0o755 })
  return { bin, executable, evidence: path.join(bin, "seen.log") }
}
