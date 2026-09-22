import { expect, test } from "bun:test"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { AcpHarnessAdapter } from "./index"
import { MemoryRuntimeStore } from "../../stores/memory"
import { waitForACPTransportRetirement } from "./transport"

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

test.skipIf(process.platform === "win32")("immediate adapter recreation waits for the old wrapper's resistant writer child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-retirement-"))
  const script = join(directory, "agent.cjs")
  const pidFile = join(directory, "writer.pid")
  await writeFile(script, `
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const file = process.argv[2];
if (fs.existsSync(file)) {
  const pid = Number(fs.readFileSync(file, 'utf8'));
  try { process.kill(pid, 0); console.error('Previous writer still alive'); process.exit(17); } catch {}
}
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], {stdio:['ignore','ignore','ignore','ipc']});
const ready = new Promise(resolve => child.once('message', resolve));
fs.writeFileSync(file, String(child.pid));
readline.createInterface({input:process.stdin}).on('line', async line => {
  const message = JSON.parse(line); if (!('id' in message)) return;
  await ready;
  const result = message.method === 'initialize' ? {protocolVersion:1, agentCapabilities:{}} : message.method === 'session/new' ? {sessionId:'upstream-' + process.pid} : {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result}) + '\\n');
});
`)
  const connection = { kind: "process" as const, command: process.execPath, args: [script, pidFile] }
  const store = new MemoryRuntimeStore()
  const first = new AcpHarnessAdapter({ harness: "retirement-test", connection, store })
  const second = new AcpHarnessAdapter({ harness: "retirement-test", connection, store })
  try {
    await first.createSession(directory, undefined, "first")
    const oldWriter = Number(await readFile(pidFile, "utf8"))
    expect(alive(oldWriter)).toBe(true)
    first.dispose()
    // No await on dispose: the new adapter must honor the transport's fence.
    await second.createSession(directory, undefined, "second")
    expect(alive(oldWriter)).toBe(false)
    const writer = Number(await readFile(pidFile, "utf8"))
    expect(writer).not.toBe(oldWriter)
    expect(alive(writer)).toBe(true)
  } finally {
    first.dispose(); second.dispose()
    await waitForACPTransportRetirement(process.cwd(), connection)
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)

test("a launch whose creation identity was never established is reported as unavailable", async () => {
  // A command that cannot be spawned has no pid, so nothing this process ever
  // saw can be signalled or verified: the fence keeps that launch and health
  // has to say so rather than report an ordinary process loss.
  const connection = { kind: "process" as const, command: join(tmpdir(), `acp-absent-${randomUUID()}`) }
  const directory = await mkdtemp(join(tmpdir(), "acp-unverified-"))
  const adapter = new AcpHarnessAdapter({ harness: "unverified-test", connection, store: new MemoryRuntimeStore() })
  try {
    expect(adapter.readRuntimeHealth(directory)).toEqual({ status: "ok" })
    await expect(adapter.createSession(directory, undefined, "session-1")).rejects.toThrow()
    expect(adapter.readRuntimeHealth(directory)).toMatchObject({
      status: "unavailable",
      reason: "harness_retirement_unresolved",
    })
  } finally {
    adapter.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
