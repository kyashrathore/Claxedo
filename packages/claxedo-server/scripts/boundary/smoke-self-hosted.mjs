import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "../..")
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-self-hosted-boundary-"))

async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  if (!address || typeof address === "string") throw new Error("failed to allocate self-hosted smoke port")
  return address.port
}

const port = await availablePort()
const childEnv = { ...process.env }
for (const name of [
  "CLAXEDO_APP_DIST_DIR",
  "CLAXEDO_EMBEDDED_AUTH",
  "CLAXEDO_SIGNED_CLOUD_AUTH",
  "CLAXEDO_WORKSPACE_AUTHORITY_URL",
]) delete childEnv[name]
const child = spawn(process.execPath, [path.join(ROOT, "dist-boundary/self-hosted/index.js")], {
  cwd: ROOT,
  env: {
    ...childEnv,
    CLAXEDO_DATA_DIR: dataDir,
    CLAXEDO_DEPLOYMENT_MODE: "local",
    CLAXEDO_SERVER_HOST: "127.0.0.1",
    CLAXEDO_SERVER_PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
})
let output = ""
child.stdout.on("data", (chunk) => { output += chunk })
child.stderr.on("data", (chunk) => { output += chunk })

try {
  const deadline = Date.now() + 15_000
  let response
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`built self-hosted process exited ${child.exitCode}:\n${output}`)
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/claxedo/health`)
      if (response.ok) break
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!response?.ok) throw new Error(`built self-hosted health timed out:\n${output}`)
  const body = await response.json()
  if (body.ok !== true || body.localExecution !== true) {
    throw new Error(`built self-hosted health returned ${JSON.stringify(body)}`)
  }
  console.log("[server-self-hosted] built Node process health passed")
} finally {
  child.kill("SIGTERM")
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ])
  if (child.exitCode === null) child.kill("SIGKILL")
  fs.rmSync(dataDir, { recursive: true, force: true })
}
