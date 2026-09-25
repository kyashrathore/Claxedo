import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

export async function interruptClaudeSteer(dataDir: string) {
  const bin = path.join(dataDir, "claude-steer-fault-bin")
  const actual = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
  const node = process.env.CLAXEDO_E2E_NODE
  if (!node || !actual) throw new Error("The Claude steer fault needs CLAXEDO_E2E_NODE and an installed Claude CLI")
  await fs.mkdir(bin)
  const gate = path.join(bin, "interrupt")
  if (process.env.CLAXEDO_E2E_H7_UNKNOWN_PASSTHROUGH !== "1") await fs.writeFile(gate, "")
  const executable = path.join(bin, "claude")
  const script = `#!${node}
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const child = spawn(${JSON.stringify(actual)}, process.argv.slice(2), { env: process.env, stdio: ["pipe", "pipe", "inherit"] })
child.stdout.pipe(process.stdout)
let tail = ""
process.stdin.on("data", (chunk) => {
  const text = tail + chunk.toString()
  tail = text.slice(-100)
  child.stdin.write(chunk)
  if (text.includes("H7UNKNOWNSTEERCLAUDE") && fs.existsSync(${JSON.stringify(gate)})) {
    fs.writeFileSync(${JSON.stringify(path.join(bin, "seen.log"))}, "steer reached Claude stdio; process interrupted before replay\\n")
    child.kill("SIGKILL")
  }
})
process.on("SIGTERM", () => child.kill("SIGTERM"))
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1))
`
  await fs.writeFile(executable, script, { mode: 0o755 })
  return { executable, evidence: path.join(bin, "seen.log") }
}
