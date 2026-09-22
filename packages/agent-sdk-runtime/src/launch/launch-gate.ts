import { spawn, type ChildProcess, type StdioOptions } from "node:child_process"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isRecord } from "@claxedo/helpers/guards"
import { launchErrorText, type CreationIdentity } from "./identity"
import {
  LaunchRefusedError,
  type LaunchOwnershipStore,
  type LaunchRole,
  type LaunchOwnerScope,
  type PreparedLaunch,
} from "./ownership-store"
import { neverExecuted, retire, type RetirementBudgets, type RetirementResult } from "./retirement"

export const GATE_EXIT = {
  channelLostBeforeActivation: 20,
  activationDeadline: 21,
  nonceMismatch: 22,
  noParentChannel: 23,
  identityUnavailable: 24,
  payloadSpawnFailed: 25,
} as const

/**
 * What the gate executes once the host has authorized it. It travels over the
 * private channel rather than in argv so that the token authorizing execution
 * and the command being executed are the same secret exchange.
 */
export type GatePayload = {
  command: string
  args: string[]
}

export type LaunchGateHandle = {
  child: ChildProcess
  /** The gate's own creation identity and the nonce it minted, or a rejection if it exited first. */
  reported: Promise<{ identity: CreationIdentity; gateNonce: string }>
  activate(gateNonce: string, payload: GatePayload): void
  /** Resolves with the payload's pid once the gate has spawned it. */
  acknowledged: Promise<number | undefined>
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

export type SpawnLaunchGateInput = {
  cwd: string
  env: NodeJS.ProcessEnv
  activationDeadlineMs: number
  stdio?: StdioOptions
}

export function spawnLaunchGate(input: SpawnLaunchGateInput): LaunchGateHandle {
  const entry = resolveLaunchGateChild()
  const child = spawn(process.execPath, [
    ...entry.runner,
    entry.file,
    "--activation-deadline-ms", String(input.activationDeadlineMs),
  ], {
    cwd: input.cwd,
    env: input.env,
    // A new POSIX session, so the payload's containment scope is a process
    // group this launch owns outright and `pgid === gate pid` holds.
    detached: process.platform !== "win32",
    stdio: withIpc(input.stdio ?? ["pipe", "pipe", "pipe"]),
  })

  // Until the gate reports, its stderr is its own and is the only account of
  // why it failed to start. After that the payload owns the stream, so this
  // stops listening rather than mixing the user's output into a launch error.
  let startupStderr = ""
  let reporting = true
  child.stderr?.on("data", (chunk: Buffer) => {
    if (reporting && startupStderr.length < 4096) startupStderr += chunk.toString()
  })

  let onReported = (_: { identity: CreationIdentity; gateNonce: string }) => {}
  let failReported = (_: unknown) => {}
  const reported = new Promise<{ identity: CreationIdentity; gateNonce: string }>((resolve, reject) => {
    onReported = resolve
    failReported = reject
  })
  let onAcknowledged = (_: number | undefined) => {}
  let failAcknowledged = (_: unknown) => {}
  const acknowledged = new Promise<number | undefined>((resolve, reject) => {
    onAcknowledged = resolve
    failAcknowledged = reject
  })
  // Neither promise is necessarily awaited on every path; an unobserved
  // rejection here is a process-wide crash under Node's default policy.
  void reported.catch(() => {})
  void acknowledged.catch(() => {})

  child.on("message", (frame) => {
    if (!isRecord(frame)) return
    if (frame.type === "identity") {
      reporting = false
      const identity = gateIdentity(frame.identity, child)
      if (!identity) {
        failReported(new Error(`Launch gate reported an identity this launcher cannot own: ${JSON.stringify(frame.identity)}`))
        child.kill("SIGKILL")
        return
      }
      onReported({ identity, gateNonce: String(frame.gateNonce) })
    }
    if (frame.type === "activated") onAcknowledged(typeof frame.pid === "number" ? frame.pid : undefined)
    if (frame.type === "failed") failAcknowledged(new Error(`Launch gate could not start the payload: ${String(frame.message)}`))
  })

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      reporting = false
      const detail = startupStderr.trim()
      const reason = new Error(
        `Launch gate exited (code ${String(code)}, signal ${String(signal)}) before reporting ${gatePhase(code)}${detail ? `: ${detail}` : ""}`,
      )
      failReported(reason)
      failAcknowledged(reason)
      resolve({ code, signal })
    })
    child.on("error", (error) => {
      reporting = false
      const reason = new Error(`Launch gate could not be started (${entry.runner.length ? `${entry.runner.join(" ")} ` : ""}${entry.file}): ${error.message}`, { cause: error })
      failReported(reason)
      failAcknowledged(reason)
      resolve({ code: null, signal: null })
    })
  })

  return {
    child,
    reported,
    acknowledged,
    exit,
    activate: (gateNonce: string, payload: GatePayload) => { child.send({ type: "activate", gateNonce, payload }) },
  }
}

/**
 * The gate is a child process, so its identity frame is a claim. It becomes an
 * ownership record — and therefore a future signal target — only if it names
 * the pid this launcher actually spawned, answers to this process, and carries
 * every field a later `verifyCreationIdentity` compares.
 */
function gateIdentity(frame: unknown, child: ChildProcess): CreationIdentity | undefined {
  if (!isRecord(frame)) return undefined
  const { pid, processGroupId, parentPid, startedAtMs, startSecond, bootTime, source } = frame
  if (typeof pid !== "number" || pid !== child.pid) return undefined
  if (typeof parentPid !== "number" || parentPid !== process.pid) return undefined
  if (typeof processGroupId !== "number" || !Number.isInteger(processGroupId) || processGroupId <= 0) return undefined
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) return undefined
  if (typeof startSecond !== "string" || !startSecond) return undefined
  if (typeof bootTime !== "string" || !bootTime) return undefined
  if (source !== "darwin-ps" && source !== "linux-procfs" && source !== "win32-cim") return undefined
  return { pid, processGroupId, parentPid, startedAtMs, startSecond, bootTime, source }
}

function gatePhase(code: number | null) {
  if (code === GATE_EXIT.activationDeadline) return "activation within its deadline"
  if (code === GATE_EXIT.channelLostBeforeActivation) return "activation: the private channel closed"
  if (code === GATE_EXIT.nonceMismatch) return "activation: the nonce did not match"
  return "a payload"
}

function withIpc(stdio: StdioOptions): StdioOptions {
  const streams = typeof stdio === "string" ? [stdio, stdio, stdio] : [...stdio]
  return [...streams, "ipc"] as StdioOptions
}

export type OwnedLaunch = {
  launchId: string
  child: ChildProcess
  /** The gate's identity: it leads the owned group, and the payload is inside it. */
  identity: CreationIdentity
  payloadPid: number | undefined
  /** Bounded TERM→KILL→verify over the owned group, recorded against the launch row. */
  retire(budgets: RetirementBudgets): Promise<RetirementResult>
}

export type LaunchOwnedProcessInput = {
  ownership: LaunchOwnershipStore
  role: LaunchRole
  parentOwnerId?: string
  scope: LaunchOwnerScope
  payload: GatePayload
  cwd: string
  env: NodeJS.ProcessEnv
  stdio?: StdioOptions
  activationDeadlineMs?: number
}

const DEFAULT_ACTIVATION_DEADLINE_MS = 10_000

/**
 * The one way this package starts a process it intends to be able to stop.
 *
 * The payload runs only after the host has durably recorded the gate's identity
 * and its authorization, so an acknowledged launch is always recoverable. A
 * refusal here leaves nothing running: every failure before activation is
 * answered by the gate exiting on its own deadline or on channel loss.
 */
export async function launchOwnedProcess(input: LaunchOwnedProcessInput): Promise<OwnedLaunch> {
  let prepared: PreparedLaunch
  try {
    prepared = await input.ownership.prepare({
      role: input.role,
      protocol: "gate",
      ...(input.parentOwnerId ? { parentOwnerId: input.parentOwnerId } : {}),
      scope: input.scope,
    })
  } catch (error) {
    throw new LaunchRefusedError(input.role, error)
  }

  const handle = spawnLaunchGate({
    cwd: input.cwd,
    env: input.env,
    activationDeadlineMs: input.activationDeadlineMs ?? DEFAULT_ACTIVATION_DEADLINE_MS,
    ...(input.stdio ? { stdio: input.stdio } : {}),
  })

  let identity: CreationIdentity
  let gateNonce: string
  try {
    ;({ identity, gateNonce } = await handle.reported)
  } catch (error) {
    await input.ownership.recordRetirement(prepared.launchId, neverExecuted()).catch(() => {})
    throw new LaunchRefusedError(input.role, error)
  }
  try {
    await input.ownership.recordIdentity(prepared.launchId, identity, gateNonce)
    await input.ownership.authorizeActivation(prepared.launchId)
  } catch (error) {
    // The gate is holding the nonce and no payload; letting its deadline expire
    // is the whole reason it exists.
    handle.child.kill("SIGTERM")
    await input.ownership.recordRetirement(prepared.launchId, neverExecuted()).catch(() => {})
    throw new LaunchRefusedError(input.role, error)
  }

  handle.activate(gateNonce, input.payload)
  const payloadPid = await handle.acknowledged
  await input.ownership.acknowledgeActivation(prepared.launchId).catch(() => {})

  return {
    launchId: prepared.launchId,
    child: handle.child,
    identity,
    payloadPid,
    retire: async (budgets: RetirementBudgets) => {
      const result = await retire({ identity }, budgets)
      await input.ownership.recordRetirement(prepared.launchId, result).catch(() => {})
      return result
    },
  }
}

let gateChild: { file: string; runner: string[] } | undefined

/**
 * Dist consumers — the desktop bundle among them — spawn this file by path, so
 * it must be resolvable from a bundled module whose own `import.meta.url` no
 * longer sits beside it. The package subpath export is the reliable answer; the
 * directory walk covers a source-first checkout whose dist has not been built.
 */
export function resolveLaunchGateChild() {
  // An explicit override is an instruction, not a cache: it is re-read every
  // time so that changing it takes effect, and it never poisons the memo for
  // the discovered path.
  const override = process.env.CLAXEDO_LAUNCH_GATE_CHILD
  if (override) {
    const spawnable = outsideArchive(override)
    if (!spawnable) throw new LaunchRefusedError("harness", new Error(`CLAXEDO_LAUNCH_GATE_CHILD points at ${override}, which does not exist`))
    const runner = runnerFor(spawnable)
    if (!runner) throw new LaunchRefusedError("harness", new Error(`CLAXEDO_LAUNCH_GATE_CHILD points at ${override}, which no runner on this host can execute`))
    return { file: spawnable, runner }
  }
  if (gateChild) return gateChild
  const attempted: string[] = []
  try {
    const resolved = createRequire(import.meta.url).resolve("@claxedo/agent-sdk-runtime/launch-gate-child")
    const spawnable = outsideArchive(resolved)
    const runner = spawnable ? runnerFor(spawnable) : undefined
    if (spawnable && runner) return (gateChild = { file: spawnable, runner })
    attempted.push(spawnable ? `${resolved} (no runner on this host can execute it)` : resolved)
  } catch (error) {
    attempted.push(`@claxedo/agent-sdk-runtime/launch-gate-child (${launchErrorText(error)})`)
  }
  for (const candidate of packageRelativeCandidates()) {
    const spawnable = outsideArchive(candidate)
    if (!spawnable) {
      attempted.push(candidate)
      continue
    }
    const runner = runnerFor(spawnable)
    if (!runner) {
      attempted.push(`${candidate} (no runner on this host can execute it)`)
      continue
    }
    return (gateChild = { file: spawnable, runner })
  }
  // A refusal, not a crash: without this file nothing can be launched with
  // recoverable ownership, which is the same answer as a store that will not
  // record one.
  throw new LaunchRefusedError("harness", new Error(
    `Could not locate the launch gate child. Tried: ${attempted.join(", ")}. Set CLAXEDO_LAUNCH_GATE_CHILD to its path.`,
  ))
}

/**
 * A packaged Electron app serves `app.asar` paths through a filesystem shim,
 * but `spawn` goes to the real kernel and an archive member has no path there.
 * An unpacked file is the same path with `app.asar.unpacked` in it.
 */
function outsideArchive(file: string) {
  if (file.includes(`${path.sep}app.asar${path.sep}`)) {
    const unpacked = file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    if (existsSync(unpacked)) return unpacked
    return undefined
  }
  return existsSync(file) ? file : undefined
}

function packageRelativeCandidates() {
  const candidates: string[] = []
  let directory = path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth++) {
    candidates.push(path.join(directory, "launch-gate-child.mjs"))
    candidates.push(path.join(directory, "launch-gate-child.ts"))
    candidates.push(path.join(directory, "dist/launch/launch-gate-child.mjs"))
    candidates.push(path.join(directory, "src/launch/launch-gate-child.ts"))
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return candidates
}

/**
 * How this host runs that file, or nothing if it cannot.
 *
 * Bun executes TypeScript directly. Node needs a loader, and `tsx` must be
 * resolved to an absolute path here rather than passed as a bare specifier:
 * the gate is spawned with the payload's working directory, so Node would
 * resolve `tsx` from the user's project and fail with ERR_MODULE_NOT_FOUND on
 * every launch. A Node host with no loader and no built `.mjs` cannot run the
 * gate at all, and says so instead of spawning a child that exits 1.
 */
function runnerFor(file: string): string[] | undefined {
  if (process.versions.bun || !file.endsWith(".ts")) return []
  try {
    return ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href]
  } catch {
    return undefined
  }
}
