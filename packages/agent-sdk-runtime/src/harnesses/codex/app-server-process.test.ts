import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { LaunchRefusedError, volatileLaunchOwnership } from "../../launch"

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

import os from "node:os"
import path from "node:path"
import { CodexAppServerProcess } from "./app-server-process"
import { installFakeCodexAppServer } from "../../test-utils/fake-codex-app-server"
import { CodexHarnessAdapter } from "./index"
import { createMemoryRuntimeStore } from "../../stores/memory"
import type { WithInternals } from "../../test-utils/class-internals"
import type { CreationIdentity, RetirementResult } from "../../launch"

const soon = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 5_000 })

test("failed approval requests receive a valid JSON-RPC error and the transport remains usable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-request-error-"))
  const binary = path.join(dir, "server.cjs")
  let server: CodexAppServerProcess | undefined
  try {
    await fs.writeFile(binary, `
const readline = require('node:readline');
let waiting;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'test/approval') {
    waiting = msg.id;
    send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {} });
  } else if (msg.id === 'approval-1') {
    send({ id: waiting, result: msg });
  } else if (msg.id !== undefined) {
    send({ id: msg.id, result: {} });
  }
});
`)
    server = await CodexAppServerProcess.start({ binary, directory: dir, env: process.env,
      requestHandler: async () => { throw new Error("permission storage failed") }, ownership, workspaceId: "ws",
    })
    expect(await server.request("test/approval", {}, soon())).toEqual({
      id: "approval-1", error: { code: -32603, message: "permission storage failed" },
    })
    expect(await server.request("test/next", {}, soon())).toEqual({})
  } finally {
    await server?.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 10_000)

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
    server = await CodexAppServerProcess.start({ binary, directory: dir, env: process.env, requestHandler: async () => ({}), ownership, workspaceId: "ws" })
    const response = await server.request("test/descendant", {}, soon()) as { descendant: number }
    descendant = response.descendant
    process.kill(descendant, 0)
    const retirement = await server.dispose()
    // Disposal is the boundary after which the owner may delete its data dir,
    // and its result says what that boundary actually established.
    expect(retirement.leader).toBe("exited")
    expect(retirement.signals.map((item) => item.signal)).toContain("SIGTERM")
    expect(() => process.kill(descendant!, 0)).toThrow()
  } finally {
    if (descendant) {
      try { process.kill(descendant, "SIGKILL") } catch {}
    }
    await server?.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 10_000)

test("a request that never answers rejects at its deadline and the transport survives", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-deadline-"))
  const binary = path.join(dir, "server.cjs")
  let server: CodexAppServerProcess | undefined
  try {
    await fs.writeFile(binary, `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'test/silent') return;
  if (msg.id !== undefined) process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + '\\n');
});
`)
    server = await CodexAppServerProcess.start({ binary, directory: dir, env: process.env, requestHandler: async () => ({}), ownership, workspaceId: "ws" })
    const deadline = { signal: new AbortController().signal, deadlineAt: Date.now() + 200 }
    await expect(server.request("test/silent", {}, deadline)).rejects.toThrow(/did not answer within its deadline/)
    expect(await server.request("test/after", {}, soon())).toEqual({ ok: true })
  } finally {
    await server?.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 10_000)

test.skipIf(process.platform === "win32")("a launch is refused when ownership cannot be recorded", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-refused-"))
  try {
    const ownership = {
      ...volatileLaunchOwnership(),
      prepare: async () => { throw new Error("launch_ownership is unavailable") },
    }
    const failure = await CodexAppServerProcess.start({
      binary: process.execPath, directory: dir, env: process.env, requestHandler: async () => ({}), ownership, workspaceId: "ws",
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(LaunchRefusedError)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 10_000)

test("a request to an app-server that already exited is refused, not left to its deadline", async () => {
  const fake = await installFakeCodexAppServer()
  const server = await CodexAppServerProcess.start({
    binary: fake.binary,
    directory: fake.directory,
    env: process.env,
    requestHandler: async () => ({}),
    ownership: volatileLaunchOwnership(),
    workspaceId: "",
  })
  try {
    await server.dispose()
    const started = Date.now()
    await expect(server.request("model/list", {}, {
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 30_000,
    })).rejects.toThrow("retired the app-server or it has exited")
    // The point is that it answered at once rather than sitting on a deadline
    // nobody can satisfy.
    expect(Date.now() - started).toBeLessThan(1_000)
  } finally {
    await fs.rm(fake.directory, { recursive: true, force: true })
  }
})

test("a retained unresolved launch stops refusing once its recorded pid is no longer that launch", async () => {
  const fake = await installFakeCodexAppServer()
  const driver = new CodexHarnessAdapter({
    binary: fake.binary,
    store: createMemoryRuntimeStore(),
    codexHome: path.join(fake.directory, "codex-home"),
  }) as unknown as WithInternals<CodexHarnessAdapter, { driver: {
    retained: { hold(identity: CreationIdentity, result: RetirementResult): void; blocker(): Promise<unknown> }
    readRuntimeHealth(): { status: string; reason?: string }
  } }>
  const codex = driver.driver
  try {
    // A retirement that established nothing, recorded against a pid that has
    // since gone: exactly what a driver holds after a failed reap.
    codex.retained.hold({
      pid: 999_999,
      processGroupId: 999_999,
      startSecond: "1",
      bootTime: "1",
      parentPid: 1,
      startedAtMs: 1000,
      source: "darwin-ps",
    }, { leader: "alive", descendants: "owned", signals: [] })
    // While it is held, the driver refuses to launch anything and says so.
    expect(codex.readRuntimeHealth()).toMatchObject({ status: "unavailable", reason: "harness_retirement_unresolved" })

    // Re-reading the recorded identity is what releases it. Without this a
    // single failed retirement refuses every later session for the life of
    // the driver.
    expect(await codex.retained.blocker()).toBeUndefined()
    expect(codex.readRuntimeHealth()).toMatchObject({ status: "ok" })
  } finally {
    await (driver as unknown as { dispose(): Promise<void> }).dispose()
    await fs.rm(fake.directory, { recursive: true, force: true })
  }
})

test("a request during the TERM grace is still sent, because a signalled process can still answer", async () => {
  const fake = await installFakeCodexAppServer()
  const server = await CodexAppServerProcess.start({
    binary: fake.binary,
    directory: fake.directory,
    env: process.env,
    requestHandler: async () => ({}),
    ownership: volatileLaunchOwnership(),
    workspaceId: "",
  })
  try {
    // Node sets `killed` on delivery, not on exit. A process inside its
    // graceful window is answering normally, and refusing its requests would
    // turn a clean shutdown into a provider outage.
    server.child.kill("SIGCONT")
    expect(server.child.killed).toBe(true)
    await expect(server.request("model/list", {}, soon())).resolves.toBeDefined()
  } finally {
    await server.dispose()
    await fs.rm(fake.directory, { recursive: true, force: true })
  }
})
