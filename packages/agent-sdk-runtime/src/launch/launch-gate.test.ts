import { afterEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { readCreationIdentity, verifyCreationIdentity } from "./identity"
import { GATE_EXIT, launchOwnedProcess, resolveLaunchGateChild, spawnLaunchGate } from "./launch-gate"
import { LaunchRefusedError, reconcileLaunch, type LaunchOwnershipStore } from "./ownership-store"
import { retire } from "./retirement"
import { volatileLaunchOwnership } from "./volatile-ownership"

const posix = process.platform !== "win32"
const budgets = { termGraceMs: 500, killVerifyMs: 500 }

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const item of cleanup.splice(0)) await item()
})

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "launch-gate-"))
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

function sleeper(seconds: number) {
  return { command: "/bin/sh", args: ["-c", `sleep ${seconds}`] }
}

/**
 * The marker is the readiness signal: a shell that has not yet reached its
 * `trap` dies on the first TERM, which would make an escalation test pass for
 * the wrong reason.
 */
function ignoresTerm(marker: string) {
  return { command: "/bin/sh", args: ["-c", `trap '' TERM; echo ready > ${marker}; while true; do sleep 0.05; done`] }
}

async function waitForFile(file: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!(await exists(file))) {
    if (Date.now() >= deadline) throw new Error(`${file} never appeared`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function gone(pid: number, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test.skipIf(!posix)("the gate child resolves to a file this process can execute", () => {
  const entry = resolveLaunchGateChild()
  expect(entry.file).toMatch(/launch-gate-child\.(ts|mjs)$/)
})

test.skipIf(!posix)("an acknowledged launch owns a group the payload is inside", async () => {
  const directory = await workspace()
  const ownership = volatileLaunchOwnership()
  const launch = await launchOwnedProcess({
    ownership,
    role: "harness",
    scope: { workspaceId: "ws", directory },
    payload: sleeper(30),
    cwd: directory,
    env: process.env,
  })
  disposable(launch)

  expect(launch.identity.processGroupId).toBe(launch.identity.pid)
  expect(launch.payloadPid).toBeGreaterThan(0)
  const payload = await readCreationIdentity(launch.payloadPid!)
  expect(payload?.processGroupId).toBe(launch.identity.pid)

  const record = await ownership.read(launch.launchId)
  expect(record?.identity?.pid).toBe(launch.identity.pid)
  expect(record?.activationAcknowledgedAt).toBeGreaterThan(0)
  expect(reconcileLaunch(record!)).toEqual({ execution: "started", because: "the gate acknowledged activation" })
})

test.skipIf(!posix)("ownership is durable before the payload can run", async () => {
  const directory = await workspace()
  const order: string[] = []
  const inner = volatileLaunchOwnership()
  const ownership: LaunchOwnershipStore = {
    ...inner,
    prepare: async (input) => { order.push("prepare"); return inner.prepare(input) },
    recordIdentity: async (id, identity, nonce) => { order.push("identity"); return inner.recordIdentity(id, identity, nonce) },
    authorizeActivation: async (id) => { order.push("authorize"); return inner.authorizeActivation(id) },
    acknowledgeActivation: async (id) => { order.push("acknowledge"); return inner.acknowledgeActivation(id) },
  }
  const marker = path.join(directory, "payload-ran")
  const launch = await launchOwnedProcess({
    ownership,
    role: "harness",
    scope: { workspaceId: "ws", directory },
    payload: { command: "/bin/sh", args: ["-c", `touch ${marker}; sleep 30`] },
    cwd: directory,
    env: process.env,
  })
  disposable(launch)
  await waitForFile(marker)

  expect(order).toEqual(["prepare", "identity", "authorize", "acknowledge"])
  expect(await exists(marker)).toBe(true)
})

test.skipIf(!posix)("a store that refuses to prepare refuses the launch and spawns nothing", async () => {
  const directory = await workspace()
  const inner = volatileLaunchOwnership()
  const ownership: LaunchOwnershipStore = {
    ...inner,
    prepare: async () => { throw new Error("launch_ownership database is unavailable") },
  }
  const before = await childCount()
  const failure = await launchOwnedProcess({
    ownership,
    role: "managed-process",
    scope: { workspaceId: "ws", directory },
    payload: sleeper(30),
    cwd: directory,
    env: process.env,
  }).catch((error: unknown) => error)

  expect(failure).toBeInstanceOf(LaunchRefusedError)
  expect((failure as LaunchRefusedError).code).toBe("launch_refused_ownership_unavailable")
  expect(await childCount()).toBe(before)
})

test.skipIf(!posix)("a store that fails after the gate reports leaves no payload running", async () => {
  const directory = await workspace()
  const marker = path.join(directory, "payload-ran")
  const inner = volatileLaunchOwnership()
  const ownership: LaunchOwnershipStore = {
    ...inner,
    recordIdentity: async () => { throw new Error("launch_ownership write failed") },
  }
  const failure = await launchOwnedProcess({
    ownership,
    role: "harness",
    scope: { workspaceId: "ws", directory },
    payload: { command: "/bin/sh", args: ["-c", `touch ${marker}; sleep 30`] },
    cwd: directory,
    env: process.env,
    activationDeadlineMs: 1000,
  }).catch((error: unknown) => error)

  expect(failure).toBeInstanceOf(LaunchRefusedError)
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(await exists(marker)).toBe(false)
})

test.skipIf(!posix)("the gate exits on its activation deadline without running a payload", async () => {
  const directory = await workspace()
  const handle = spawnLaunchGate({ cwd: directory, env: process.env, activationDeadlineMs: 200 })
  const { identity } = await handle.reported
  expect(identity.processGroupId).toBe(identity.pid)
  const exit = await handle.exit
  expect(exit.code).toBe(GATE_EXIT.activationDeadline)
})

test.skipIf(!posix)("the gate refuses a nonce it did not mint", async () => {
  const directory = await workspace()
  const handle = spawnLaunchGate({ cwd: directory, env: process.env, activationDeadlineMs: 5000 })
  await handle.reported
  handle.activate("00000000-0000-4000-8000-000000000000", sleeper(30))
  const exit = await handle.exit
  expect(exit.code).toBe(GATE_EXIT.nonceMismatch)
})

test.skipIf(!posix)("the gate exits when the private channel closes before activation", async () => {
  const directory = await workspace()
  const handle = spawnLaunchGate({ cwd: directory, env: process.env, activationDeadlineMs: 30_000 })
  await handle.reported
  handle.child.disconnect()
  const exit = await handle.exit
  expect(exit.code).toBe(GATE_EXIT.channelLostBeforeActivation)
})

test.skipIf(!posix)("a prepared launch that never reported reconciles as no execution", async () => {
  const ownership = volatileLaunchOwnership()
  const prepared = await ownership.prepare({ role: "harness", protocol: "gate", scope: { workspaceId: "ws" } })
  const record = await ownership.read(prepared.launchId)
  expect(reconcileLaunch(record!).execution).toBe("none")
})

test.skipIf(!posix)("a prepared direct launch stays unknown, because its spawn precedes its record", async () => {
  const ownership = volatileLaunchOwnership()
  const prepared = await ownership.prepare({ role: "terminal", protocol: "direct", scope: { workspaceId: "ws" } })
  const record = await ownership.read(prepared.launchId)
  expect(reconcileLaunch(record!).execution).toBe("unknown")
})

test.skipIf(!posix)("retirement escalates to KILL for a payload that ignores TERM", async () => {
  const directory = await workspace()
  const ownership = volatileLaunchOwnership()
  const launch = await launchOwnedProcess({
    ownership,
    role: "harness",
    scope: { workspaceId: "ws", directory },
    payload: ignoresTerm(path.join(directory, "ready")),
    cwd: directory,
    env: process.env,
  })
  const payloadPid = launch.payloadPid!
  await waitForFile(path.join(directory, "ready"))
  const result = await launch.retire(budgets)

  expect(result.leader).toBe("exited")
  expect(result.signals.map((item) => item.signal)).toEqual(["SIGTERM", "SIGKILL"])
  expect(result.signals.every((item) => item.delivered)).toBe(true)
  expect(await gone(payloadPid)).toBe(true)
  expect((await ownership.read(launch.launchId))?.cleanup?.leader).toBe("exited")
})

test.skipIf(!posix)("a descendant that leaves the group leaves cleanup unknown", async () => {
  const directory = await workspace()
  const escapee = path.join(directory, "escapee.mjs")
  const marker = path.join(directory, "escaped-pid")
  // macOS ships no `setsid` binary; `detached` is the same syscall.
  await fs.writeFile(escapee, [
    `import { spawn } from "node:child_process"`,
    `import { writeFileSync } from "node:fs"`,
    `const escaped = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" })`,
    `writeFileSync(process.argv[2], String(escaped.pid))`,
    `escaped.unref()`,
    `setTimeout(() => {}, 30000)`,
  ].join("\n"))
  const ownership = volatileLaunchOwnership()
  const launch = await launchOwnedProcess({
    ownership,
    role: "harness",
    scope: { workspaceId: "ws", directory },
    payload: { command: process.execPath, args: [escapee, marker] },
    cwd: directory,
    env: process.env,
  })
  for (let attempt = 0; attempt < 60 && !(await exists(marker)); attempt++) await new Promise((r) => setTimeout(r, 50))
  const escaped = Number((await fs.readFile(marker, "utf8")).trim())
  cleanup.push(() => { try { process.kill(escaped, "SIGKILL") } catch {} })

  const result = await launch.retire(budgets)
  expect(result.leader).toBe("exited")
  expect(result.descendants).toBe("unknown")
  // Measured, not assumed: the escapee survives the group it left.
  expect(await gone(escaped, 200)).toBe(false)
})

test.skipIf(!posix)("retirement refuses to signal a recorded identity another process now holds", async () => {
  const directory = await workspace()
  const ownership = volatileLaunchOwnership()
  const launch = await launchOwnedProcess({
    ownership,
    role: "harness",
    scope: { workspaceId: "ws", directory },
    payload: sleeper(30),
    cwd: directory,
    env: process.env,
  })
  disposable(launch)

  const stale = { ...launch.identity, startSecond: "Thu Jan  1 00:00:00 1970" }
  const result = await retire({ identity: stale }, budgets)

  expect(result.leader).toBe("unknown")
  expect(result.descendants).toBe("unknown")
  expect(result.error?.code).toBe("signal_denied")
  expect(result.signals[0]?.refusal).toBe("identity_mismatch")
  expect((await verifyCreationIdentity(launch.identity)).state).toBe("live")
})

test.skipIf(!posix)("retirement refuses a recorded process that does not lead its group", async () => {
  const child = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" })
  cleanup.push(() => void child.kill("SIGKILL"))
  const identity = await readCreationIdentity(child.pid!)
  const result = await retire({ identity: identity! }, budgets)

  expect(identity!.processGroupId).not.toBe(identity!.pid)
  expect(result.signals[0]?.refusal).toBe("not_group_leader")
  expect(result.error?.code).toBe("ownership_unverified")
  expect(await gone(child.pid!, 100)).toBe(false)
})

test.skipIf(!posix)("an identity probe that fails reports unknown rather than clear", async () => {
  const directory = await workspace()
  const ownership = volatileLaunchOwnership()
  const launch = await launchOwnedProcess({
    ownership,
    role: "harness",
    scope: { workspaceId: "ws", directory },
    payload: sleeper(30),
    cwd: directory,
    env: process.env,
  })
  disposable(launch)

  const broken = await fs.mkdtemp(path.join(os.tmpdir(), "no-ps-"))
  cleanup.push(() => fs.rm(broken, { recursive: true, force: true }))
  const realPath = process.env.PATH
  process.env.PATH = broken
  try {
    const result = await retire({ identity: launch.identity }, budgets)
    expect(result.leader).toBe("unknown")
    expect(result.descendants).toBe("unknown")
    expect(result.error?.code).toBe("ownership_unverified")
    expect(result.signals[0]?.refusal).toBe("identity_unverifiable")
  } finally {
    process.env.PATH = realPath
  }
  expect(await gone(launch.identity.pid, 100)).toBe(false)
})

test.skipIf(!posix)("retiring an already exited leader reports its surviving group as owned", async () => {
  const directory = await workspace()
  const ownership = volatileLaunchOwnership()
  const launch = await launchOwnedProcess({
    ownership,
    role: "harness",
    scope: { workspaceId: "ws", directory },
    payload: sleeper(30),
    cwd: directory,
    env: process.env,
  })
  const payloadPid = launch.payloadPid!
  cleanup.push(() => { try { process.kill(payloadPid, "SIGKILL") } catch {} })
  process.kill(launch.identity.pid, "SIGKILL")
  expect(await gone(launch.identity.pid)).toBe(true)

  const result = await retire({ identity: launch.identity }, budgets)
  expect(result.leader).toBe("exited")
  expect(result.descendants).toBe("owned")
  expect(result.signals).toEqual([])
  expect(await gone(payloadPid, 100)).toBe(false)
})

test.skipIf(!posix)("a second retirement of a settled launch is idempotent", async () => {
  const directory = await workspace()
  const ownership = volatileLaunchOwnership()
  const launch = await launchOwnedProcess({
    ownership,
    role: "harness",
    scope: { workspaceId: "ws", directory },
    payload: sleeper(30),
    cwd: directory,
    env: process.env,
  })
  const first = await launch.retire(budgets)
  const second = await launch.retire(budgets)

  expect(first.leader).toBe("exited")
  expect(second.leader).toBe("exited")
  expect(second.signals).toEqual([])
  expect(await ownership.listUnresolved()).toEqual([])
})

test.skipIf(!posix)("closeNative runs between TERM and KILL", async () => {
  const directory = await workspace()
  const ownership = volatileLaunchOwnership()
  const launch = await launchOwnedProcess({
    ownership,
    role: "terminal",
    scope: { workspaceId: "ws", directory },
    payload: ignoresTerm(path.join(directory, "ready")),
    cwd: directory,
    env: process.env,
  })
  await waitForFile(path.join(directory, "ready"))
  let closedAfterTerm: boolean | undefined
  const result = await retire({
    identity: launch.identity,
    closeNative: () => { closedAfterTerm = true },
  }, budgets)

  expect(closedAfterTerm).toBe(true)
  expect(result.signals.map((item) => item.signal)).toEqual(["SIGTERM", "SIGKILL"])
})

function disposable(launch: { identity: { pid: number } }) {
  cleanup.push(() => { try { process.kill(-launch.identity.pid, "SIGKILL") } catch {} })
}

async function exists(file: string) {
  return await fs.access(file).then(() => true, () => false)
}

async function childCount() {
  return await new Promise<number>((resolve) => {
    const ps = spawn("ps", ["-o", "ppid=", "-ax"], { stdio: ["ignore", "pipe", "ignore"] })
    let out = ""
    ps.stdout.on("data", (chunk: Buffer) => { out += chunk.toString() })
    ps.on("close", () => resolve(out.split("\n").filter((line) => Number(line.trim()) === process.pid).length))
  })
}

/**
 * The owner dies mid-protocol. Each case runs the production module inside a
 * throwaway parent that kills itself at one boundary, then reads the record the
 * way a fresh owner would.
 */
const crashProxy = (mode: "before-identity" | "before-ack", store: string, marker: string) => [
  `import { launchOwnedProcess } from ${JSON.stringify(new URL("./launch-gate.ts", import.meta.url).href)}`,
  `import { readFileSync, writeFileSync } from "node:fs"`,
  `import { randomUUID } from "node:crypto"`,
  `const file = ${JSON.stringify(store)}`,
  `const read = () => { try { return JSON.parse(readFileSync(file, "utf8")) } catch { return {} } }`,
  `const patch = (id, change) => { const all = read(); all[id] = { ...all[id], ...change }; writeFileSync(file, JSON.stringify(all)) }`,
  `const ownership = {`,
  `  prepare: async (input) => { const p = { launchId: randomUUID(), role: input.role, protocol: input.protocol, scope: input.scope, preparedAt: Date.now() }; patch(p.launchId, p); return p },`,
  `  recordIdentity: async (id, identity, gateNonce) => patch(id, { identity, gateNonce, identityReceivedAt: Date.now() }),`,
  `  authorizeActivation: async (id) => patch(id, { activationAuthorizedAt: Date.now() }),`,
  mode === "before-ack"
    ? `  acknowledgeActivation: async () => { process.kill(process.pid, "SIGKILL") },`
    : `  acknowledgeActivation: async (id) => patch(id, { activationAcknowledgedAt: Date.now() }),`,
  `  recordRetirement: async (id, cleanup) => patch(id, { cleanup }),`,
  `  read: async (id) => read()[id],`,
  `  listUnresolved: async () => Object.values(read()),`,
  `}`,
  mode === "before-identity" ? `process.kill(process.pid, "SIGKILL")` : ``,
  `await launchOwnedProcess({`,
  `  ownership, role: "harness", scope: { workspaceId: "ws" },`,
  `  payload: { command: "/bin/sh", args: ["-c", "touch ${marker}; sleep 30"] },`,
  `  cwd: ${JSON.stringify(process.cwd())}, env: process.env, activationDeadlineMs: 4000,`,
  `})`,
  `await new Promise((resolve) => setTimeout(resolve, 20000))`,
].join("\n")

async function runCrashProxy(source: string, directory: string) {
  const file = path.join(directory, "crash-proxy.mjs")
  await fs.writeFile(file, source)
  const proxy = spawn(process.execPath, [file], { stdio: ["ignore", "ignore", "pipe"] })
  cleanup.push(() => void proxy.kill("SIGKILL"))
  return await new Promise<void>((resolve) => proxy.on("exit", () => resolve()))
}

test.skipIf(!posix || !process.versions.bun)("an owner that dies before using the identity leaves no payload", async () => {
  const directory = await workspace()
  const store = path.join(directory, "ownership.json")
  const marker = path.join(directory, "payload-ran")
  await runCrashProxy(crashProxy("before-identity", store, marker), directory)

  await new Promise((resolve) => setTimeout(resolve, 5000))
  expect(await exists(marker)).toBe(false)
  const records: Record<string, never> = JSON.parse(await fs.readFile(store, "utf8").catch(() => "{}"))
  for (const record of Object.values(records)) expect(reconcileLaunch(record).execution).toBe("none")
})

test.skipIf(!posix || !process.versions.bun)("an owner that dies before the acknowledgement leaves a reacquirable launch", async () => {
  const directory = await workspace()
  const store = path.join(directory, "ownership.json")
  const marker = path.join(directory, "payload-ran")
  await runCrashProxy(crashProxy("before-ack", store, marker), directory)

  await waitForFile(marker, 10_000)
  const records: Record<string, LaunchOwnershipRecordShape> = JSON.parse(await fs.readFile(store, "utf8"))
  const record = Object.values(records)[0]!
  expect(record.activationAcknowledgedAt).toBeUndefined()
  expect(reconcileLaunch(record as never).execution).toBe("unknown")

  cleanup.push(() => { try { process.kill(-record.identity!.pid, "SIGKILL") } catch {} })
  expect((await verifyCreationIdentity(record.identity!)).state).toBe("live")
  const result = await retire({ identity: record.identity! }, budgets)
  expect(result.leader).toBe("exited")
  expect(await gone(record.identity!.pid)).toBe(true)
})

type LaunchOwnershipRecordShape = {
  identity?: Awaited<ReturnType<typeof readCreationIdentity>>
  activationAuthorizedAt?: number
  activationAcknowledgedAt?: number
}

test.skipIf(!posix)("the payload cannot run while authorization is still being recorded", async () => {
  const directory = await workspace()
  const marker = path.join(directory, "payload-ran")
  const inner = volatileLaunchOwnership()
  let releaseAuthorization = () => {}
  const authorizing = new Promise<void>((resolve) => { releaseAuthorization = resolve })
  let authorized = false
  const ownership: LaunchOwnershipStore = {
    ...inner,
    authorizeActivation: async (id) => {
      await authorizing
      await inner.authorizeActivation(id)
      authorized = true
    },
  }

  const launching = launchOwnedProcess({
    ownership,
    role: "harness",
    scope: { workspaceId: "ws", directory },
    payload: { command: "/bin/sh", args: ["-c", `touch ${marker}; sleep 30`] },
    cwd: directory,
    env: process.env,
    activationDeadlineMs: 30_000,
  })

  // Held open: the gate has reported and is waiting, and nothing may have run.
  await new Promise((resolve) => setTimeout(resolve, 600))
  expect(authorized).toBe(false)
  expect(await exists(marker)).toBe(false)

  releaseAuthorization()
  const launch = await launching
  disposable(launch)
  await waitForFile(marker)
  expect(authorized).toBe(true)
})

test.skipIf(!posix)("an owner that dies after authorizing leaves a running payload and an unknown row", async () => {
  const directory = await workspace()
  const store = path.join(directory, "ownership.json")
  const marker = path.join(directory, "payload-ran")
  await runCrashProxy(crashProxy("before-ack", store, marker), directory)

  await waitForFile(marker, 10_000)
  const records: Record<string, { activationAuthorizedAt?: number; activationAcknowledgedAt?: number }> =
    JSON.parse(await fs.readFile(store, "utf8"))
  const record = Object.values(records)[0]!

  expect(record.activationAuthorizedAt).toBeGreaterThan(0)
  expect(record.activationAcknowledgedAt).toBeUndefined()
  expect(reconcileLaunch(record as never)).toEqual({
    execution: "unknown",
    because: "activation was authorized and its delivery is unwitnessed",
  })
})

test.skipIf(!posix)("a boot identity that differs is a mismatch, not a live process", async () => {
  const directory = await workspace()
  const ownership = volatileLaunchOwnership()
  const launch = await launchOwnedProcess({
    ownership,
    role: "harness",
    scope: { workspaceId: "ws", directory },
    payload: sleeper(30),
    cwd: directory,
    env: process.env,
  })
  disposable(launch)

  // Same pid, same start second, previous boot: pids restart low after a
  // reboot, so without this the record of a dead machine names a live process.
  const rebooted = { ...launch.identity, bootTime: String(Number(launch.identity.bootTime) - 86_400) }
  const verdict = await verifyCreationIdentity(rebooted)

  expect(verdict.state).toBe("identity_mismatch")
  expect((await verifyCreationIdentity(launch.identity)).state).toBe("live")
  const refusal = await retire({ identity: rebooted }, budgets)
  expect(refusal.error?.code).toBe("signal_denied")
  expect(refusal.signals[0]?.refusal).toBe("identity_mismatch")
  expect((await verifyCreationIdentity(launch.identity)).state).toBe("live")
})
