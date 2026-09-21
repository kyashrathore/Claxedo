import { spawn, type ChildProcess, type StdioOptions } from "node:child_process"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isRecord } from "@claxedo/helpers/guards"
import { launchErrorText, type CreationIdentity } from "./identity"
import {
  LaunchRefusedError,
  type LaunchOwnershipStore,
  type LaunchRole,
  type LaunchScope,
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
  shell?: boolean
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
    if (frame.type === "identity" && isRecord(frame.identity)) {
      onReported({ identity: frame.identity as unknown as CreationIdentity, gateNonce: String(frame.gateNonce) })
    }
    if (frame.type === "activated") onAcknowledged(typeof frame.pid === "number" ? frame.pid : undefined)
    if (frame.type === "failed") failAcknowledged(new Error(`Launch gate could not start the payload: ${String(frame.message)}`))
  })

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      const reason = new Error(`Launch gate exited (code ${String(code)}, signal ${String(signal)}) before reporting ${gatePhase(code)}`)
      failReported(reason)
      failAcknowledged(reason)
      resolve({ code, signal })
    })
    child.on("error", (error) => {
      failReported(error)
      failAcknowledged(error)
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
  scope: LaunchScope
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

  const { identity, gateNonce } = await handle.reported
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
  if (gateChild) return gateChild
  const override = process.env.CLAXEDO_LAUNCH_GATE_CHILD
  if (override) {
    if (!existsSync(override)) throw new Error(`CLAXEDO_LAUNCH_GATE_CHILD points at ${override}, which does not exist`)
    return (gateChild = { file: override, runner: runnerFor(override) })
  }
  const attempted: string[] = []
  try {
    const resolved = createRequire(import.meta.url).resolve("@claxedo/agent-sdk-runtime/launch-gate-child")
    if (existsSync(resolved)) return (gateChild = { file: resolved, runner: runnerFor(resolved) })
    attempted.push(resolved)
  } catch (error) {
    attempted.push(`@claxedo/agent-sdk-runtime/launch-gate-child (${launchErrorText(error)})`)
  }
  for (const candidate of packageRelativeCandidates()) {
    if (existsSync(candidate)) return (gateChild = { file: candidate, runner: runnerFor(candidate) })
    attempted.push(candidate)
  }
  throw new Error(`Could not locate the launch gate child. Tried: ${attempted.join(", ")}. Set CLAXEDO_LAUNCH_GATE_CHILD to its path.`)
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

function runnerFor(file: string) {
  if (!file.endsWith(".ts") || process.versions.bun) return []
  return ["--import", "tsx"]
}
