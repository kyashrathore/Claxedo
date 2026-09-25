import fs from "node:fs/promises"
import path from "node:path"

export async function writeLineProxyFault(input: {
  dataDir: string
  binName: string
  executableName: string
  actual: string
  setup: string
  onRequest: string
  onReply: string
}) {
  const node = process.env.CLAXEDO_E2E_NODE
  if (!node) throw new Error("The line proxy fault needs CLAXEDO_E2E_NODE")
  const bin = path.join(input.dataDir, input.binName)
  await fs.mkdir(bin, { recursive: true })
  const executable = path.join(bin, input.executableName)
  const evidence = path.join(bin, "seen.log")
  const script = `#!${node}
import { spawn } from "node:child_process"
${input.setup}
const child = spawn(${JSON.stringify(input.actual)}, process.argv.slice(2), { env: process.env, stdio: ["pipe", "pipe", "inherit"] })
const versionMode = process.argv.includes("--version")
let incoming = ""
let outgoing = ""
function onRequest(request, line) { ${input.onRequest} }
function onReply(reply, line) { ${input.onReply} }
process.stdin.on("data", (chunk) => {
  incoming += chunk.toString()
  let end
  while ((end = incoming.indexOf("\\n")) >= 0) {
    const line = incoming.slice(0, end)
    incoming = incoming.slice(end + 1)
    onRequest(JSON.parse(line), line)
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
    if (onReply(JSON.parse(line), line) !== false) process.stdout.write(line + "\\n")
  }
})
process.on("SIGTERM", () => child.kill("SIGTERM"))
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1))
`
  await fs.writeFile(executable, script, { mode: 0o755 })
  return { bin, executable, evidence }
}
