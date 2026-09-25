import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

export async function staleCodexInventory(dataDir: string) {
  const bin = path.join(dataDir, "codex-inventory-fault-bin")
  const actual = execFileSync("which", ["codex"], { encoding: "utf8" }).trim()
  const node = process.env.CLAXEDO_E2E_NODE
  if (!node || !actual) throw new Error("The Codex inventory fault needs CLAXEDO_E2E_NODE and an installed Codex CLI")
  await fs.mkdir(bin)
  const stale = path.join(bin, "stale")
  if (process.env.CLAXEDO_E2E_CODEX_INVENTORY_PASSTHROUGH !== "1") await fs.writeFile(stale, "")
const wrapper = `#!${node}
const { spawn } = require("node:child_process")
const fs = require("node:fs")
fs.appendFileSync(${JSON.stringify(path.join(bin, "seen.log"))}, "started\\n")
const child = spawn(${JSON.stringify(actual)}, process.argv.slice(2), { env: process.env, stdio: ["pipe", "pipe", "inherit"] })
const inventory = new Set()
let firstInventory
let incoming = ""
let outgoing = ""
process.stdin.on("data", (chunk) => {
  const text = chunk.toString()
  incoming += text
  let end
  while ((end = incoming.indexOf("\\n")) >= 0) {
    const line = incoming.slice(0, end)
    incoming = incoming.slice(end + 1)
    try {
      const request = JSON.parse(line)
      if (request.method === "thread/backgroundTerminals/list") {
        fs.appendFileSync(${JSON.stringify(path.join(bin, "seen.log"))}, "inventory\\n")
        inventory.add(request.id)
      }
    } catch (error) { process.stderr.write(String(error) + "\\n") }
  }
  child.stdin.write(chunk)
})
child.stdout.on("data", (chunk) => {
  outgoing += chunk.toString()
  let end
  while ((end = outgoing.indexOf("\\n")) >= 0) {
    const line = outgoing.slice(0, end)
    outgoing = outgoing.slice(end + 1)
    let reply
    try { reply = JSON.parse(line) } catch (error) { process.stderr.write(String(error) + "\\n") }
    if (inventory.delete(reply?.id)) {
      fs.appendFileSync(${JSON.stringify(path.join(bin, "seen.log"))}, "reply " + line + "\\n")
      if (firstInventory && fs.existsSync(${JSON.stringify(stale)})) {
        process.stdout.write(JSON.stringify({ id: reply.id, result: firstInventory }) + "\\n")
        continue
      }
      firstInventory = reply.result
    }
    process.stdout.write(line + "\\n")
  }
})
process.on("SIGTERM", () => child.kill("SIGTERM"))
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1))
`
  await fs.writeFile(path.join(bin, "codex"), wrapper, { mode: 0o755 })
  return bin
}
