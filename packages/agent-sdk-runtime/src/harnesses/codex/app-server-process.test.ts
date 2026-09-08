import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CodexAppServerProcess } from "./app-server-process"

test.skipIf(process.platform === "win32")("dispose stops a descendant that outlives the app-server", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-process-tree-"))
  const binary = path.join(dir, "server.cjs")
  let descendant: number | undefined
  let server: CodexAppServerProcess | undefined
  try {
    await fs.writeFile(binary, `
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const child = spawn(process.execPath, ['-e',
  "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"
], { stdio: ['ignore', 'pipe', 'inherit'] });
const ready = new Promise(resolve => child.stdout.once('data', resolve));
// Drain readiness output without forwarding it into the app-server protocol.
child.stdout.resume();
process.on('SIGTERM', () => process.exit(0));
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined) {
    await ready;
    process.stdout.write(JSON.stringify({ id: msg.id, result: { descendant: child.pid } }) + '\\n');
  }
});
`)
    server = await CodexAppServerProcess.start({ binary, directory: dir, env: process.env, requestHandler: async () => ({}) })
    const response = await server.request("test/descendant", {}) as { descendant: number }
    descendant = response.descendant
    process.kill(descendant, 0)
    await server.dispose()
    // Disposal is the boundary after which the owner may delete its data dir.
    expect(() => process.kill(descendant!, 0)).toThrow()
  } finally {
    if (descendant) {
      try { process.kill(descendant, "SIGKILL") } catch {}
    }
    await server?.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 10_000)
