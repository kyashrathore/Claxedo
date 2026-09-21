import { execFileSync, fork, type ChildProcess } from "node:child_process"
import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import { parseRecoveryOutcome, type RecoveryMachineTarget, type RecoveryOperation } from "@claxedo/agent-runtime-contract"

import { readArray, readNumber, readRecord, readString } from "../src/shared/json-read"
import { claxedoServerForkOptions } from "../src/main/server-child-process"
import { createDaemonFetch, type DaemonFetch } from "../src/main/daemon-request"
import { CLAXEDO_DAEMON_PROTOCOL, type ClaxedoDaemonDiscovery } from "../src/main/server-daemon-discovery"
import { recoverPublishedDaemon } from "../src/main/daemon-recovery"
import { localServerBundleEntry } from "./local-server"

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
export const RUNTIME_RECOVERY_SMOKE_BUNDLE = localServerBundleEntry(PACKAGE_DIR)

/**
 * The daemon has no runtime knob for its idle grace, so the whole script runs
 * against a short one. That is what makes the handoff step a proof: a daemon
 * nothing pins exits within a few hundred milliseconds of the release, so a
 * daemon still alive well past that is alive because the terminal pins it.
 */
const IDLE_GRACE_MS = 2_000
const POLL_INTERVAL_MS = 50

/** Long enough for a 30s drain budget to expire and the operation to settle. */
const DRAIN_SETTLE_MS = 60_000

export type RuntimeRecoverySmokeStep = { name: string; detail: string }

export type RuntimeRecoverySmokeReport = {
  steps: RuntimeRecoverySmokeStep[]
  strayProcesses: string[]
}

export async function runRuntimeRecoverySmoke(): Promise<RuntimeRecoverySmokeReport> {
  if (!fs.existsSync(RUNTIME_RECOVERY_SMOKE_BUNDLE)) {
    throw new Error(`${RUNTIME_RECOVERY_SMOKE_BUNDLE} is missing; run \`bun run predev\` in packages/claxedo-desktop first`)
  }

  const steps: RuntimeRecoverySmokeStep[] = []
  const record = (name: string, detail: string) => {
    steps.push({ name, detail })
    console.log(`[runtime-recovery-smoke] ${name}: ${detail}`)
  }

  const marker = `claxedo-recovery-smoke-${randomUUID()}`
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-recovery-smoke-"))
  const workspaceDirectory = path.join(root, "workspace")
  fs.mkdirSync(workspaceDirectory)
  execFileSync("git", ["init", workspaceDirectory], { stdio: "ignore" })

  const port = await freePort()
  const generation = `recovery-smoke-${randomUUID()}`
  const token = randomUUID()
  const discoveryPath = path.join(root, "data", "local-daemon.json")
  const serverLog = fs.openSync(path.join(root, "server.log"), "a")
  const child = fork(RUNTIME_RECOVERY_SMOKE_BUNDLE, [], {
    ...claxedoServerForkOptions({
      ...stringEnv(),
      HOME: root,
      CLAXEDO_CHILD_PORT: String(port),
      CLAXEDO_DAEMON_PROTOCOL: String(CLAXEDO_DAEMON_PROTOCOL),
      CLAXEDO_DAEMON_TOKEN: token,
      CLAXEDO_DAEMON_GENERATION: generation,
      CLAXEDO_DAEMON_DISCOVERY_PATH: discoveryPath,
      CLAXEDO_DAEMON_IDLE_GRACE_MS: String(IDLE_GRACE_MS),
      CLAXEDO_DAEMON_POLL_INTERVAL_MS: String(POLL_INTERVAL_MS),
      CLAXEDO_DATA_DIR: path.join(root, "data"),
      CLAXEDO_DIAGNOSTICS_LAUNCH_ID: generation,
      CLAXEDO_DIAGNOSTICS_GENERATION: generation,
    }, serverLog),
    execPath: electronExecutable(),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  fs.closeSync(serverLog)

  let stderr = ""
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk) => { stderr += String(chunk) })
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
  const base = `http://127.0.0.1:${port}`
  const daemon = createDaemonFetch({ endpoint: () => ({ origin: base, capability: token }) })
  const directory = encodeURIComponent(workspaceDirectory)

  try {
    await waitForHealth(base, child, () => stderr)

    // Held first: nothing else pins the daemon yet, and the idle grace above
    // is short enough to end it before the terminal exists.
    const leaseId = id(await json(await daemon("/api/claxedo/daemon/leases", { method: "POST" }), 201), "the daemon lease")
    record("lease held", `daemon lease ${leaseId}`)

    const discovery: ClaxedoDaemonDiscovery = JSON.parse(fs.readFileSync(discoveryPath, "utf8"))
    if (discovery.generation !== generation || discovery.pid !== child.pid) {
      throw new Error(`discovery names generation ${discovery.generation} pid ${String(discovery.pid)}`)
    }
    const identity = discovery.identity
    if (!identity) throw new Error("discovery published no process creation identity")
    record("discovery carries identity", `pid ${String(identity.pid)} startSecond ${identity.startSecond} bootTime ${identity.bootTime}`)

    const empty = await inspectMachine(daemon)
    if (empty.target.ownerGeneration !== generation) {
      throw new Error(`inventory names generation ${empty.target.ownerGeneration}`)
    }
    record("machine inventory", `${String(empty.owners.length)} owners, ${String(empty.residencyPins)} residency pins, receipt ${empty.receipt}`)

    const ptyId = id(await json(await daemon(`/api/wr/pty?directory=${directory}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: marker, initialCommand: `printf '${marker}\\n'; sleep 600` }),
    }), 200), "the terminal")
    await until(async () => (await inspectMachine(daemon)).owners.includes(`terminal:${ptyId}`),
      "the terminal to appear in the machine inventory")
    record("terminal owned", `terminal:${ptyId}`)

    await json(await daemon(`/api/claxedo/daemon/leases/${leaseId}`, { method: "DELETE" }), 200)
    await Bun.sleep(IDLE_GRACE_MS * 3)
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the daemon exited after a handoff release while a terminal was still running:\n${stderr.slice(-2000)}`)
    }
    await expectStatus(await daemon(`/api/wr/pty/${encodeURIComponent(ptyId)}?directory=${directory}`), 200)
    record("handoff release survived", `no client lease for ${String(IDLE_GRACE_MS * 3)}ms, terminal still served`)

    const drain = await submit(daemon, {
      requestId: `smoke-drain-${randomUUID()}`,
      action: "drain_daemon",
      target: empty.target,
      scopeRevision: (await inspectMachine(daemon)).scopeRevision,
      attempt: 1,
    })
    const blocked = await until(async () => {
      const outcome = await read(daemon, drain.operationId)
      return outcome.state === "needs_action" || outcome.state === "failed" ? outcome : undefined
    }, "the drain to reach its deadline", DRAIN_SETTLE_MS)
    if (blocked.state !== "needs_action") throw new Error(`drain settled as ${blocked.state}`)
    const named = blocked.initiatingError?.message ?? ""
    if (!named.includes(ptyId)) {
      throw new Error(`the blocked drain did not name terminal ${ptyId}: ${named}`)
    }
    record("drain blocked", `${blocked.initiatingError?.code ?? "no code"} naming terminal:${ptyId}`)

    const gated = await inspectMachine(daemon)
    if (gated.gate?.operationId !== drain.operationId) {
      throw new Error(`machine ingress is not gated by ${drain.operationId}`)
    }
    record("ingress gated", `gate holds ${String(gated.gate.owners.length)} owners for ${drain.operationId}`)

    await submit(daemon, {
      requestId: `smoke-release-${randomUUID()}`,
      action: "release_drain",
      target: empty.target,
      scopeRevision: gated.scopeRevision,
      attempt: 1,
      linkedOperationId: drain.operationId,
    })
    const reopened = await inspectMachine(daemon)
    if (reopened.gate) throw new Error(`the release left a gate for ${reopened.gate.operationId}`)
    record("drain released", `ingress reopened for ${drain.operationId}`)

    let retired = false
    const mismatched = await recoverPublishedDaemon({
      // The same pid under a boot this record cannot have been written in.
      discovery: { ...discovery, identity: { ...identity, bootTime: `${identity.bootTime}-not-this-boot` } },
      authorize: () => true,
      retireLaunch: () => {
        retired = true
        throw new Error("a mismatched identity must never reach a signal")
      },
    })
    if (retired) throw new Error("the launcher signalled a pid it could not identify")
    if (mismatched.replacementAllowed) throw new Error("the launcher allowed a replacement it never contained")
    const refusal = mismatched.outcome.kind === "operation" ? mismatched.outcome.operation.initiatingError : undefined
    if (refusal?.code !== "signal_denied") throw new Error(`mismatched identity answered ${refusal?.code ?? "nothing"}`)
    await expectStatus(await fetch(`${base}/api/claxedo/health`), 200)
    record("identity mismatch refused", `${refusal.code}; the daemon it did not signal is still healthy`)

    await expectStatus(await daemon(`/api/wr/pty/${encodeURIComponent(ptyId)}?directory=${directory}`, { method: "DELETE" }), 200)
    const code = await raceExit(exited, DRAIN_SETTLE_MS)
    if (code !== 0) throw new Error(`the unpinned daemon exited with ${String(code)}:\n${stderr.slice(-2000)}`)
    if (fs.existsSync(discoveryPath)) throw new Error("the exited daemon left its discovery record behind")
    record("daemon released", "the last terminal removed, the daemon exited 0 and cleared its discovery")

    const strayProcesses = strays(marker)
    if (strayProcesses.length > 0) {
      throw new Error(`processes survived the smoke: ${strayProcesses.join(", ")}`)
    }
    record("no strays", `pgrep -f ${marker} is empty`)
    return { steps, strayProcesses }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await raceExit(exited, 5_000)
    }
    for (const pid of strays(marker)) {
      try { process.kill(Number(pid.split(" ")[0]), "SIGKILL") } catch { /* already gone */ }
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function electronExecutable() {
  const named = process.env.CLAXEDO_TEST_ELECTRON_EXECUTABLE?.trim()
  if (named) return named
  const resolved: unknown = createRequire(import.meta.url)("electron")
  if (typeof resolved !== "string") throw new Error("the electron package did not resolve to an executable path")
  return resolved
}

function stringEnv() {
  return Object.fromEntries(
    Object.entries(Bun.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function strays(marker: string) {
  const found = Bun.spawnSync({ cmd: ["pgrep", "-fl", marker] })
  return new TextDecoder().decode(found.stdout).split("\n").map((line) => line.trim()).filter(Boolean)
}

/** The parts of the machine inventory this smoke makes claims about. */
async function inspectMachine(daemon: DaemonFetch) {
  const body = await json(await daemon("/api/claxedo/daemon/recovery"), 200)
  const target = readRecord(body, "target")
  const machineId = readString(target, "machineId")
  const ownerGeneration = readString(target, "ownerGeneration")
  const scopeRevision = readString(body, "scopeRevision")
  const residencyPins = readNumber(body, "residencyPins")
  if (readString(target, "scope") !== "machine" || !machineId || !ownerGeneration || !scopeRevision || residencyPins === undefined) {
    throw new Error(`the daemon answered no machine inventory: ${JSON.stringify(body)}`)
  }
  const gate = readRecord(body, "gate")
  return {
    target: { scope: "machine", machineId, ownerGeneration } satisfies RecoveryMachineTarget,
    scopeRevision,
    residencyPins,
    receipt: readString(body, "receipt") ?? "unstated",
    owners: (readArray(body, "owners") ?? []).map((owner) => readString(owner, "id") ?? "unnamed"),
    ...(gate
      ? {
          gate: {
            operationId: readString(gate, "operationId") ?? "unnamed",
            owners: (readArray(gate, "owners") ?? []).map(String),
          },
        }
      : {}),
  }
}

async function submit(daemon: DaemonFetch, request: unknown): Promise<RecoveryOperation> {
  const response = await daemon("/api/claxedo/daemon/recovery", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  })
  const outcome = parseRecoveryOutcome(await response.json())
  if (outcome.kind !== "operation") {
    throw new Error(`recovery submission refused (${String(response.status)}): ${JSON.stringify(outcome)}`)
  }
  return outcome.operation
}

async function read(daemon: DaemonFetch, operationId: string): Promise<RecoveryOperation> {
  const outcome = parseRecoveryOutcome(
    await json(await daemon(`/api/claxedo/daemon/recovery/operations/${encodeURIComponent(operationId)}`), 200))
  if (outcome.kind !== "operation") throw new Error(`operation ${operationId} read back as ${JSON.stringify(outcome)}`)
  return outcome.operation
}

async function json(response: Response, status: number): Promise<unknown> {
  const body = await response.text()
  if (response.status !== status) throw new Error(`expected ${String(status)}, got ${String(response.status)}: ${body}`)
  return JSON.parse(body)
}

function id(value: unknown, what: string) {
  const read = readString(value, "id")
  if (!read) throw new Error(`${what} answered no id: ${JSON.stringify(value)}`)
  return read
}

async function expectStatus(response: Response, status: number) {
  if (response.status !== status) {
    throw new Error(`expected ${String(status)}, got ${String(response.status)}: ${await response.text()}`)
  }
}

async function until<T>(ready: () => Promise<T | undefined | false>, what: string, budgetMs = 15_000): Promise<T> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const value = await ready()
    if (value) return value
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function raceExit(exited: Promise<number | null>, budgetMs: number) {
  return await Promise.race([exited, Bun.sleep(budgetMs).then(() => "timeout" as const)])
}

async function freePort() {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!port) throw new Error("could not allocate a free port")
  return port
}

async function waitForHealth(base: string, child: ChildProcess, stderr: () => string) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`claxedo-server exited before becoming healthy:\n${stderr().slice(-2000)}`)
    }
    await Bun.sleep(100)
    const res = await fetch(`${base}/api/claxedo/health`, { signal: AbortSignal.timeout(1_000) }).catch(() => undefined)
    if (res?.ok) return
  }
  throw new Error("claxedo-server did not become healthy in time")
}

if (import.meta.main) {
  const report = await runRuntimeRecoverySmoke()
  console.log(`[runtime-recovery-smoke] ${String(report.steps.length)} steps passed`)
  process.exit(0)
}
