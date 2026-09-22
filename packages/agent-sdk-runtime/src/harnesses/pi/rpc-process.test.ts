import { afterEach, describe, expect, test } from "bun:test"
import { PiJsonLines, PiRpcProcess } from "./rpc-process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { volatileLaunchOwnership } from "../../launch"

/** This suite asserts protocol and retirement, not record durability. */
const volatile = volatileLaunchOwnership()

/**
 * Every gate this suite starts, tracked from the moment its identity is
 * recorded. An activated gate leads the harness payload's group and
 * deliberately outlives its parent, so a test that fails before disposing one
 * would leave it inherited by init.
 */
const started: number[] = []
const ownership = {
  ...volatile,
  recordIdentity: async (launchId: string, identity: { pid: number }, gateNonce?: string) => {
    started.push(identity.pid)
    return volatile.recordIdentity(launchId, identity as never, gateNonce)
  },
}

function groupAlive(processGroupId: number) {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"
  }
}

afterEach(async () => {
  const swept = started.splice(0)
  for (const processGroupId of swept) {
    try { process.kill(-processGroupId, "SIGKILL") } catch {}
  }
  for (let attempt = 0; attempt < 40 && swept.some(groupAlive); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect(swept.filter(groupAlive)).toEqual([])
})


describe("Pi JSONL", () => {
  test("handles chunks, CRLF and literal Unicode separators without splitting JSON strings", () => {
    const parser = new PiJsonLines()
    expect(parser.read('{"type":"notice","text":"a\u2028b')).toEqual([])
    expect(parser.read('\u2029c"}\r\n{"type":"ready"}\n')).toEqual([
      { type: "notice", text: "a\u2028b\u2029c" },
      { type: "ready" },
    ])
  })
  test("rejects malformed protocol records", () => {
    expect(() => new PiJsonLines().read("null\n")).toThrow("Invalid Pi RPC record")
    expect(() => new PiJsonLines().read("not json\n")).toThrow()
  })
})

test.skipIf(!process.env.PI_EXECUTABLE)(
  "real pinned Pi answers correlated requests and rejects unknown commands",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-rpc-"))
    const rpc = await PiRpcProcess.start({
      binary: process.env.PI_EXECUTABLE!,
      directory,
      args: ["--mode", "rpc", "--no-session"],
      env: { ...process.env, PI_CODING_AGENT_DIR: directory },
      ownership,
    })
    try {
      const [state, catalog] = await Promise.all([rpc.request("get_state", {}, soon()), rpc.request("get_available_models", {}, soon())])
      expect(state).toHaveProperty("sessionId")
      expect(catalog).toHaveProperty("models")
      await expect(rpc.request("unknown-command", {}, soon())).rejects.toThrow()
      const exited = new Promise<void>((resolve) => rpc.onExit(() => resolve()))
      await rpc.dispose()
      await exited
      await expect(rpc.request("get_state", {}, soon())).rejects.toThrow("disposed")
    } finally {
      await rpc.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
  15_000,
)

test.skipIf(!process.env.PI_EXECUTABLE)(
  "real Pi does not load an untrusted checkout extension",
  async () => {
    const fs = await import("node:fs/promises")
    const directory = await mkdtemp(path.join(tmpdir(), "pi-untrusted-"))
    const extensionDir = path.join(directory, ".pi", "extensions")
    const marker = path.join(directory, "extension-loaded")
    await fs.mkdir(extensionDir, { recursive: true })
    await fs.writeFile(
      path.join(extensionDir, "untrusted.ts"),
      `import { writeFileSync } from "node:fs"; export default function () { writeFileSync(${JSON.stringify(marker)}, "loaded"); }`,
    )
    const rpc = await PiRpcProcess.start({
      binary: process.env.PI_EXECUTABLE!,
      directory,
      args: ["--mode", "rpc", "--no-session"],
      env: { ...process.env, PI_CODING_AGENT_DIR: path.join(directory, "managed-profile") },
      ownership,
    })
    try {
      expect(await rpc.request("get_state", {}, soon())).toHaveProperty("sessionId")
      expect(
        await fs.stat(marker).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    } finally {
      await rpc.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
  15_000,
)


/**
 * A fake Pi speaking the same JSONL protocol, so transport failure and OS exit
 * can be driven apart without the pinned binary.
 */
async function fakePi(body: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-fake-"))
  const binary = path.join(directory, "pi.cjs")
  await writeFile(binary, body)
  return { directory, binary }
}

const respondingPi = `
const readline = require('node:readline');
const child = require('node:child_process').spawn(process.execPath, ['-e',
  "process.on('SIGTERM', () => {}); console.error('descendant ' + process.pid); setInterval(() => {}, 1000)"
], { stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.on('data', (chunk) => process.stdout.write(JSON.stringify({ type: 'descendant', pid: Number(String(chunk).trim().split(' ')[1]) }) + '\\n'));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'close-stdin') { process.stdin.destroy(); return; }
  process.stdout.write(JSON.stringify({ type: 'response', id: message.id, success: true, data: { ok: true } }) + '\\n');
});
`

const soon = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 })

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

test.skipIf(process.platform === "win32")("dispose retires the owned group, including a descendant that ignores TERM", async () => {
  const { directory, binary } = await fakePi(respondingPi)
  const rpc = await PiRpcProcess.start({ binary: process.execPath, directory, args: [binary], env: process.env, ownership })
  try {
    const descendant = await new Promise<number>((resolve) => {
      rpc.onEvent((event) => { if (event.type === "descendant") resolve(Number(event.pid)) })
    })
    expect(alive(descendant)).toBe(true)

    const result = await rpc.dispose()
    expect(result.leader).toBe("exited")
    expect(result.signals.map((item) => item.signal)).toEqual(["SIGTERM", "SIGKILL"])
    expect(alive(descendant)).toBe(false)
  } finally {
    await rpc.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)

test.skipIf(process.platform === "win32")("exit is published when the OS reports it, not when disposal starts", async () => {
  const { directory, binary } = await fakePi(respondingPi)
  const observed: string[] = []
  const observer = {
    register: () => ({ update: () => {}, exit: (event: { reason: string }) => observed.push(event.reason) }),
  } as never
  const rpc = await PiRpcProcess.start({ binary: process.execPath, directory, args: [binary], env: process.env, observer, ownership })
  const exits: string[] = []
  rpc.onExit((error) => exits.push(error.message))
  try {
    await rpc.request("ping", {}, soon())

    const retiring = rpc.dispose()
    expect(observed).toEqual([])
    expect(exits).toEqual([])
    expect(rpc.exited).toBe(false)
    // The transport is already unusable, which is a separate fact from exit.
    expect(rpc.alive).toBe(false)

    const result = await retiring
    expect(result.leader).toBe("exited")
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(rpc.exited).toBe(true)
    expect(observed).toEqual(["exited"])
    expect(exits.length).toBe(1)
  } finally {
    await rpc.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
