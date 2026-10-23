import { createReadStream, createWriteStream, watch as watchDirectory } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { PAIRING_TTL_MS, pairingCode } from "@claxedo/account-contract/machine"
import { DECISION_EXIT_CODE, HostConnectDecisionError, PAIRING_REFUSALS, pairingRefusal, redeemPairing, type PairingMachine } from "@claxedo/host-connector/bootstrap"
import { createHostKeyPair, hostKeyPairFromJwk, newHostId } from "@claxedo/host-connector/host-identity"
import { newHostState, type HostState, type HostStateStore } from "@claxedo/host-connector/host-state"
import {
  createMachinePairingClient,
  createMachineSignedTransport,
  decisionCode,
  REDEEM_REQUEST_TIMEOUT_MS,
  type MachinePairingStage,
} from "@claxedo/host-connector/machine-transport"
import { cliVersion } from "../version"
import { operatingSystem } from "./report"
import type { ConnectArgs } from "./args"
import { withBootstrapRetry, type HostDeps } from "./host"
import type { connectPaths } from "./paths"

export type PairingDeps = {
  cwd: () => string
  machine: () => Promise<{ hostname: string; os: string; arch: string; home: string }>
  /** Asks once on the terminal; undefined when nobody can answer, as under cloud-init or a pipe with no terminal. */
  ask: (question: string) => Promise<boolean | undefined>
  watchState: (dir: string, onChange: () => void) => () => void
}

type PairInput = {
  host: HostDeps
  store: HostStateStore
  paths: ReturnType<typeof connectPaths>
  controlPlaneUrl: string
  removeDir: (dir: string) => Promise<void>
  pairing: PairingDeps
  log: (line: string) => void
}

/** How long a paired machine's first folder may take to serve before the command stops waiting and says so. */
const READY_WAIT_MS = 60_000
/** A directory watch can miss the rename that lands the service's write; Bun's drops it after the temporary file's event. */
const READY_RECHECK_MS = 2_000
const ANSWER_RECHECK_MS = 20_000

/** The controlling terminal, which a script piped into `sh` still has even though its stdin is the script. */
async function openTerminal() {
  if (process.platform === "win32") {
    return process.stdin.isTTY ? { input: process.stdin, output: process.stdout, close: () => undefined } : undefined
  }
  const input = createReadStream("/dev/tty")
  const opened = await new Promise<boolean>((resolve) => {
    input.once("open", () => resolve(true))
    input.once("error", () => resolve(false))
  })
  if (!opened) return undefined
  const output = createWriteStream("/dev/tty")
  return { input, output, close: () => { input.destroy(); output.end() } }
}

async function askOnTerminal(question: string): Promise<boolean | undefined> {
  const terminal = await openTerminal()
  if (!terminal) return undefined
  const prompt = createInterface({ input: terminal.input, output: terminal.output })
  try {
    const answer = (await prompt.question(`${question} [Y/n] `)).trim().toLowerCase()
    return answer === "" || answer === "y" || answer === "yes"
  } finally {
    prompt.close()
    terminal.close()
  }
}

export function defaultPairingDeps(): PairingDeps {
  return {
    cwd: () => process.cwd(),
    machine: async () => ({ hostname: os.hostname(), os: operatingSystem(), arch: process.arch, home: os.homedir() }),
    ask: askOnTerminal,
    watchState: (dir, onChange) => {
      const watcher = watchDirectory(dir, () => onChange())
      return () => watcher.close()
    },
  }
}

function folderBasename(folder: string) {
  return path.basename(folder) || folder
}

function signedClients(state: HostState, deps: PairInput) {
  const enrollment = state.enrollment
  if (!enrollment) throw new Error("this machine has no enrollment")
  return async () => {
    const keys = await hostKeyPairFromJwk(state.private_key_jwk)
    const options = { controlPlaneUrl: state.control_plane_url, keys, enrollmentId: enrollment.enrollment_id, hostId: state.host_id, keyVersion: enrollment.key_version, fetch: deps.host.fetch }
    return { client: createMachinePairingClient(options), transport: createMachineSignedTransport(options) }
  }
}

/** The owner's answer, heard on the doorbell and read again on a slow interval; a decision the control plane refuses with is an answer too. */
export async function awaitPairingAnswer(state: HostState, deps: PairInput): Promise<MachinePairingStage> {
  const { client, transport } = await signedClients(state, deps)()
  return await new Promise<MachinePairingStage>((resolve) => {
    let settled = false
    const cleanup: Array<() => void> = []
    const finish = (stage: MachinePairingStage) => {
      if (settled) return
      settled = true
      for (const stop of cleanup) stop()
      resolve(stage)
    }
    const check = async () => {
      try {
        const pairing = await client.self()
        if (pairing && pairing.stage !== "awaiting_approval") finish(pairing.stage)
      } catch (error) {
        const code = decisionCode(error)
        if (code === "enrollment_denied" || code === "enrollment_revoked") finish("denied")
        if (code === "enrollment_approval_expired") finish("expired")
      }
    }
    const watch = transport.watch?.({ onEvent: () => void check() })
    if (watch) cleanup.push(() => watch.close())
    const recheck = deps.host.setInterval(() => void check(), ANSWER_RECHECK_MS)
    cleanup.push(() => recheck.cancel())
    const deadline = deps.host.setTimeout(() => finish("expired"), PAIRING_TTL_MS + ANSWER_RECHECK_MS)
    cleanup.push(() => deadline.cancel())
    void check()
  })
}

/** Whether the service this command started serves its first folder within the wait, read from the state file it writes. */
export async function awaitFirstServe(deps: PairInput): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const cleanup: Array<() => void> = []
    const finish = (served: boolean) => {
      if (settled) return
      settled = true
      for (const stop of cleanup) stop()
      resolve(served)
    }
    const check = async () => {
      const state = await deps.store.load().catch(() => undefined)
      if (state?.run?.served?.some((entry) => entry.connected)) finish(true)
    }
    cleanup.push(deps.pairing.watchState(deps.paths.dir, () => void check()))
    const recheck = deps.host.setInterval(() => void check(), READY_RECHECK_MS)
    cleanup.push(() => recheck.cancel())
    const deadline = deps.host.setTimeout(() => finish(false), READY_WAIT_MS)
    cleanup.push(() => deadline.cancel())
    void check()
  })
}

/**
 * A state this code cannot pair through: enrolled against another control
 * plane, or an enrollment its owner removed. Connecting again replaces it,
 * after asking once when someone can answer.
 */
async function replaceable(existing: HostState, deps: PairInput, why: string): Promise<boolean> {
  deps.log(`${why}; connecting again replaces it.`)
  const answer = await deps.pairing.ask("Connect this machine again?")
  if (answer === false) {
    deps.log("Kept this machine as it was.")
    return false
  }
  await deps.removeDir(deps.paths.dir)
  deps.log(existing.service ? "Its service stays installed and serves the new connection." : "Connecting again.")
  return true
}

async function redeemNew(code: string, folder: string, deps: PairInput, existing: HostState | undefined) {
  const facts = await deps.pairing.machine()
  const resuming = existing && !existing.enrollment ? existing : undefined
  const created = resuming ? undefined : await createHostKeyPair()
  const keys = created ?? await hostKeyPairFromJwk(resuming?.private_key_jwk ?? {})
  const state = resuming ?? newHostState({
    hostId: newHostId(),
    privateKeyJwk: created?.privateKeyJwk ?? {},
    controlPlaneUrl: deps.controlPlaneUrl,
    cliRoots: [],
    storageRoot: deps.paths.storageRoot,
  })
  const machine: PairingMachine = { hostname: facts.hostname, os: facts.os, arch: facts.arch, cli_version: cliVersion(), folder, home: facts.home }
  return await withBootstrapRetry(deps.host, "redeem", ({ timeoutMs }) =>
    redeemPairing({ code, store: deps.store, state, keys, machine, fetch: deps.host.fetch, requestTimeoutMs: Math.min(REDEEM_REQUEST_TIMEOUT_MS, timeoutMs) }))
}

/**
 * `connect --pair CODE`: enroll this machine through a pairing, or, on a
 * machine already connected to the code's person, ask to share the folder
 * the command runs in. Returns the state to serve, or the exit code when the
 * command is done.
 */
export async function pair(args: ConnectArgs, existing: HostState | undefined, deps: PairInput): Promise<{ state: HostState; folder: string } | number> {
  const code = pairingCode(args.pair ?? "")
  if (!code) throw new HostConnectDecisionError(PAIRING_REFUSALS.pairing_invalid ?? "", { code: "pairing_invalid" })
  const folder = await deps.host.resolvePath(deps.pairing.cwd())
  let current = existing
  if (current?.enrollment && current.control_plane_url !== deps.controlPlaneUrl) {
    if (!(await replaceable(current, deps, `This machine is connected to ${current.control_plane_url}`))) return DECISION_EXIT_CODE
    current = undefined
  }
  if (current?.enrollment) {
    const asked = await askToShare(current, code, folder, deps)
    if (asked !== "removed") return asked
    if (!(await replaceable(current, deps, "This machine was removed from Claxedo"))) return DECISION_EXIT_CODE
    current = undefined
  }
  const redeemed = await redeemNew(code, folder, deps, current)
  deps.log(`Approve this machine in Claxedo to share ${folder}: ${redeemed.approvalUrl}`)
  return { state: redeemed.state, folder }
}

async function askToShare(state: HostState, code: string, folder: string, deps: PairInput): Promise<number | "removed"> {
  const { client } = await signedClients(state, deps)()
  try {
    const home = (await deps.pairing.machine()).home
    const { approvalUrl } = await client.requestFolder({ code, folder, home })
    deps.log(`Approve sharing ${folder} in Claxedo: ${approvalUrl}`)
  } catch (error) {
    const machineCode = decisionCode(error)
    if (machineCode === "enrollment_revoked" || machineCode === "enrollment_denied") return "removed"
    throw pairingRefusal(error, state.control_plane_url) ?? error
  }
  const stage = await awaitPairingAnswer(state, deps)
  if (stage === "denied") {
    deps.log(`Sharing ${folder} was declined in Claxedo.`)
    return DECISION_EXIT_CODE
  }
  if (stage === "expired") {
    deps.log("No one answered within 15 minutes; run the command again.")
    return DECISION_EXIT_CODE
  }
  deps.log(`${folderBasename(folder)} is shared from this machine.`)
  return 0
}

/** After a new machine's service is started: say how its owner answered, and when the folder it asked to share serves. */
export async function reportPairing(state: HostState, folder: string, deps: PairInput): Promise<number> {
  const stage = await awaitPairingAnswer(state, deps)
  if (stage === "denied") {
    deps.log("The owner denied this machine in Claxedo.")
    return DECISION_EXIT_CODE
  }
  if (stage === "expired") {
    deps.log("No one approved this machine within 15 minutes; run the command again.")
    return DECISION_EXIT_CODE
  }
  deps.log("Approved; connecting.")
  if (await awaitFirstServe(deps)) {
    deps.log(`${folderBasename(folder)} is ready in Claxedo.`)
    return 0
  }
  deps.log("Still connecting; `claxedo status` shows how far it got.")
  return 0
}
