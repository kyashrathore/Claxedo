import { randomUUID } from "node:crypto"
import { access } from "node:fs/promises"
import type { IpcMainInvokeEvent } from "electron"
import { pairingCode } from "@claxedo/account-contract/machine"
import { readField, readString } from "@claxedo/helpers/readers"
import { recordHostKey, scanHostKey, type HostKey } from "./host-key"
import { fetchConnectScript, installOverSsh, type InstallOutcome, type ScriptFetch } from "./install"
import { isUnknownHostKey, PROBE_COMMAND, readSshTarget, runSshTool, sshArgv, sshFailure, SYSTEM_SSH_TOOLS, type SshFailure, type SshTarget, type SshTools } from "./ssh"

/**
 * Named operations carrying data the person typed, never a command line: main
 * builds every ssh argument, fetches the script from the account's own control
 * plane, and a known host is trusted only through a scan main itself made.
 */
export const SSH_CONNECT_OPERATIONS = ["check", "trust", "install", "cancel"] as const

export type SshConnectOperation = (typeof SSH_CONNECT_OPERATIONS)[number]

export const SSH_CONNECT_STEP_CHANNEL = "claxedo.sshConnect.step"

export function sshConnectChannel(operation: SshConnectOperation) {
  return `claxedo.sshConnect.${operation}`
}

export type SshCheck =
  | { readonly kind: "reachable"; readonly os: string; readonly arch: string }
  | { readonly kind: "unknownHost"; readonly scanId: string; readonly keys: readonly HostKey[] }
  | { readonly kind: "failed"; readonly failure: SshFailure }

type Sender = Pick<IpcMainInvokeEvent["sender"], "id" | "send" | "isDestroyed" | "once" | "removeListener">

export type SshConnectIpcListener = (event: { readonly sender: Sender }, ...args: unknown[]) => unknown

export type SshConnectIpcTarget = { handle(channel: string, listener: SshConnectIpcListener): unknown }

const PROBE_DEADLINE_MS = 30_000
const SCAN_LIMIT = 16
const SUPPORTED_OS = new Set(["Linux", "Darwin"])
const RUN_ID = /^[A-Za-z0-9-]{1,64}$/

const failedCheck = (failure: SshFailure): SshCheck => ({ kind: "failed", failure })

async function keyFileMissing(target: SshTarget): Promise<boolean> {
  if (!target.identityFile) return false
  return await access(target.identityFile).then(() => false, () => true)
}

async function probeMachine(tools: SshTools, target: SshTarget): Promise<SshCheck | "unknownHost"> {
  if (await keyFileMissing(target)) return failedCheck({ reason: "keyMissing" })
  const exit = await runSshTool(tools, "ssh", sshArgv(target, PROBE_COMMAND), { deadlineMs: PROBE_DEADLINE_MS })
  if (exit.kind === "missing") return failedCheck({ reason: "sshMissing" })
  if (exit.code === 255 || exit.code === null) {
    if (isUnknownHostKey(exit.stderr)) return "unknownHost"
    tools.log?.(`ssh check of ${target.destination} failed: ${exit.lastLine ?? String(exit.code)}`)
    return failedCheck({ reason: sshFailure(exit.stderr) })
  }
  const [os = "", arch = ""] = exit.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/) ?? []
  if (exit.code === 0 && SUPPORTED_OS.has(os)) return { kind: "reachable", os, arch }
  return failedCheck({ reason: "unsupportedOs", ...(exit.code === 0 && os ? { os } : {}) })
}

export function registerSshConnectIpc(input: {
  readonly ipcMain: SshConnectIpcTarget
  readonly controlPlaneUrl: string | undefined
  readonly tools?: SshTools
  readonly fetch?: ScriptFetch
}) {
  const tools = input.tools ?? SYSTEM_SSH_TOOLS
  const scans = new Map<string, { readonly senderId: number; readonly target: SshTarget; readonly lines: readonly string[] }>()
  const runs = new Map<string, { readonly senderId: number; readonly controller: AbortController }>()

  const check = async (sender: Sender, target: SshTarget): Promise<SshCheck> => {
    const probed = await probeMachine(tools, target)
    if (probed !== "unknownHost") return probed
    const scan = await scanHostKey(tools, target)
    if (scan.kind === "failed") return failedCheck(scan.failure)
    const scanId = randomUUID()
    scans.set(scanId, { senderId: sender.id, target, lines: scan.lines })
    for (const oldest of [...scans.keys()].slice(0, Math.max(0, scans.size - SCAN_LIMIT))) scans.delete(oldest)
    return { kind: "unknownHost", scanId, keys: scan.keys }
  }

  const trust = async (sender: Sender, payload: unknown): Promise<SshCheck> => {
    const scanId = readString(payload, "scanId") ?? ""
    const scan = scans.get(scanId)
    if (!scan || scan.senderId !== sender.id) return failedCheck({ reason: "invalidTarget" })
    scans.delete(scanId)
    if (!(await recordHostKey(tools, scan.target, scan.lines))) return failedCheck({ reason: "hostKeyNotRecorded" })
    const probed = await probeMachine(tools, scan.target)
    return probed === "unknownHost" ? failedCheck({ reason: "hostKeyNotRecorded" }) : probed
  }

  const install = async (sender: Sender, payload: unknown): Promise<InstallOutcome> => {
    const runId = readString(payload, "runId") ?? ""
    const target = readSshTarget(readField(payload, "target"))
    const code = pairingCode(readString(payload, "code") ?? "")
    if (!RUN_ID.test(runId) || runs.has(runId) || !target || !code) return { kind: "failed", failure: { reason: "invalidTarget" } }
    if (!input.controlPlaneUrl) return { kind: "failed", failure: { reason: "unavailable" } }
    const controller = new AbortController()
    const abort = () => controller.abort()
    runs.set(runId, { senderId: sender.id, controller })
    sender.once("destroyed", abort)
    try {
      const script = await fetchConnectScript(input.controlPlaneUrl, { ...(input.fetch ? { fetch: input.fetch } : {}), ...(tools.log ? { log: tools.log } : {}) })
      if (script.kind === "failed") return script
      if (controller.signal.aborted) return { kind: "cancelled" }
      return await installOverSsh({
        tools,
        target,
        code,
        script: script.bytes,
        signal: controller.signal,
        onStep: (step) => {
          if (!sender.isDestroyed()) sender.send(SSH_CONNECT_STEP_CHANNEL, { runId, ...step })
        },
      })
    } finally {
      runs.delete(runId)
      sender.removeListener("destroyed", abort)
    }
  }

  const cancel = async (sender: Sender, payload: unknown) => {
    const run = runs.get(readString(payload, "runId") ?? "")
    if (run?.senderId === sender.id) run.controller.abort()
  }

  const handlers: Record<SshConnectOperation, (sender: Sender, payload: unknown) => Promise<unknown>> = {
    check: async (sender, payload) => {
      const target = readSshTarget(payload)
      return target ? await check(sender, target) : failedCheck({ reason: "invalidTarget" })
    },
    trust,
    install,
    cancel,
  }

  const channels = SSH_CONNECT_OPERATIONS.map((operation) => {
    const channel = sshConnectChannel(operation)
    input.ipcMain.handle(channel, (event, payload) => handlers[operation](event.sender, payload))
    return channel
  })
  return { channels }
}
