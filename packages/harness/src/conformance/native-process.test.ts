import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createTestServices } from "./test-support/services"
import { processAlive } from "../../e2e/harness/process-alive"
import { PiRpc } from "../transports/pi-rpc/rpc"
import { CodexRpc } from "../transports/codex-app-server/rpc"

const deadline = () => ({ at: Date.now() + 5_000, signal: new AbortController().signal })
const source = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setTimeout(() => process.exit(0), 12000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => process.stdout.write(JSON.stringify({ type: 'descendant', method: 'descendant', params: { pid: child.pid }, pid: child.pid }) + '\\n'));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'exit-parent' || message.method === 'exit-parent') process.exit(0);
});
`

const NODE = process.env.CLAXEDO_E2E_NODE ?? Bun.which("node") ?? process.execPath

for (const kind of ["pi", "codex"] as const) {
  test.skipIf(process.platform === "win32")(`${kind} RPC retirement stops a TERM-resistant descendant after its parent exits`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `${kind}-retirement-`))
    const services = createTestServices()
    const script = path.join(root, "peer.cjs")
    await fs.writeFile(script, source)
    const owned = await services.spawn({ file: NODE, args: [script], cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
      { role: "harness", label: `${kind} retirement peer`, signal: new AbortController().signal })
    const rpc = kind === "pi" ? new PiRpc(owned, services.clock, () => {}) : new CodexRpc(owned, services.clock)
    let descendant: number | undefined
    try {
      descendant = await new Promise<number>((resolve) => {
        if (rpc instanceof PiRpc) rpc.onMessage((message) => { if (message.type === "descendant") resolve(Number(message.pid)) })
        else rpc.onMessage((message) => { if (message.method === "descendant") resolve((message.params as { pid: number }).pid) })
      })
      expect(processAlive(descendant)).toBe(true)
      if (rpc instanceof PiRpc) rpc.send({ type: "exit-parent" })
      else rpc.notify("exit-parent")
      expect(await owned.exited).toEqual({ code: 0, signal: null })
      expect(processAlive(descendant)).toBe(true)
      await rpc.retire(deadline())
      expect(processAlive(descendant)).toBe(false)
    } finally {
      if (descendant !== undefined && processAlive(descendant)) process.kill(descendant, "SIGKILL")
      try { await owned.retire(deadline()) }
      finally { await fs.rm(root, { recursive: true, force: true }) }
    }
  }, 15_000)
}

test.skipIf(process.platform === "win32")("a signalled Codex process still answers until the OS reports exit", async () => {
  const services = createTestServices()
  const owned = await services.spawn({ file: NODE, args: ["-e", `
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
process.on('SIGTERM', () => send({ method: 'term-observed' }));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'exit') process.exit(0);
  if (message.id !== undefined) send({ id: message.id, result: { ok: true } });
});
`], cwd: os.tmpdir(), env: {} }, { role: "harness", label: "Codex signalled peer", signal: new AbortController().signal })
  const rpc = new CodexRpc(owned, services.clock)
  try {
    expect(await rpc.request("ready")).toEqual({ ok: true })
    const signalled = new Promise<void>((resolve) => rpc.onMessage((message) => { if (message.method === "term-observed") resolve() }))
    process.kill(owned.pid, "SIGTERM")
    await signalled
    expect(await rpc.request("after-signal")).toEqual({ ok: true })
    rpc.notify("exit")
    await owned.exited
  } finally {
    if (processAlive(owned.pid)) process.kill(owned.pid, "SIGKILL")
    await owned.exited
    await rpc.retire(deadline())
  }
})
