import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const attempts = []
const listener = net.createServer((socket) => {
  socket.once("data", (data) => {
    attempts.push(data.toString("utf8").split("\r\n", 1)[0])
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
  })
})
await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject))
const address = listener.address()
assert.ok(address && typeof address !== "string")
const proxy = `http://127.0.0.1:${address.port}`
const packageDir = path.resolve(import.meta.dirname, "../..")
const shimDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sdk-no-network-"))
const installAttempts = path.join(shimDir, "install-attempts")
fs.writeFileSync(path.join(shimDir, "npm"), '#!/bin/sh\nprintf "npm\\n" >> "$CLAXEDO_NETWORK_ATTEMPT_LOG"\nexit 88\n', { mode: 0o755 })
fs.writeFileSync(path.join(shimDir, "codex"), '#!/bin/sh\nprintf "codex\\n" >> "$CLAXEDO_NETWORK_ATTEMPT_LOG"\nexit 88\n', { mode: 0o755 })

try {
  const files = process.argv.slice(2)
  const child = spawn("bun", files.length ? ["test", ...files, "--timeout", "20000"] : ["run", "test"], {
    cwd: packageDir,
    env: {
      ...process.env,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
      CLAXEDO_NETWORK_ATTEMPT_LOG: installAttempts,
      CLAXEDO_LIVE_HARNESS: "",
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      ALL_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      all_proxy: proxy,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on("data", (chunk) => {
      output += chunk.toString()
      destination.write(chunk)
    })
  }
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", resolve)
  })
  assert.equal(fs.existsSync(installAttempts) ? fs.readFileSync(installAttempts, "utf8") : "", "", "unit suite invoked a network-capable installer or ambient Codex")
  assert.deepEqual(attempts, [], `unit suite attempted vendor traffic: ${attempts.join(", ")}`)
  console.log("agent-sdk-runtime unit suite made no vendor requests")
  assert.match(output, /Ran \d+ tests? across \d+ files?\./, "unit suite did not finish enumerating its tests")
  assert.equal(code, 0, "agent-sdk-runtime unit suite failed")
} finally {
  await new Promise((resolve) => listener.close(resolve))
  fs.rmSync(shimDir, { recursive: true, force: true })
}
