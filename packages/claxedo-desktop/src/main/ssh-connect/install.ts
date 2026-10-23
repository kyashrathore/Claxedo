import { createHash } from "node:crypto"
import { CONNECT_SCRIPT_PATH, CONNECT_SCRIPT_SHA256_HEADER } from "@claxedo/account-contract/machine"
import { withDeadlineSignal } from "@claxedo/helpers/deadline"
import { noConnectionReuseFetch } from "../account/no-reuse-fetch"
import { FOLDER_MISSING_EXIT, installCommand, runSshTool, sshArgv, sshFailure, type SshFailure, type SshTarget, type SshTools } from "./ssh"

const SCRIPT_DEADLINE_MS = 20_000
const SCRIPT_LIMIT = 1024 * 1024
const STEP = /^(\d+)\/(\d+) (.+)$/

export type ConnectScript = { readonly kind: "verified"; readonly bytes: Buffer } | { readonly kind: "failed"; readonly failure: SshFailure }

export type InstallStep = { readonly index: number; readonly total: number; readonly title: string }

export type InstallOutcome = { readonly kind: "finished" } | { readonly kind: "cancelled" } | { readonly kind: "failed"; readonly failure: SshFailure }

export type ScriptFetch = (input: URL, init: RequestInit) => Promise<Response>

const failedWith = (failure: SshFailure) => ({ kind: "failed", failure }) as const

async function readScript(response: Response): Promise<ConnectScript> {
  const stated = response.headers.get(CONNECT_SCRIPT_SHA256_HEADER)?.trim().toLowerCase()
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > SCRIPT_LIMIT || !stated) return failedWith({ reason: "scriptUnverified" })
  const actual = createHash("sha256").update(bytes).digest("hex")
  return actual === stated ? { kind: "verified", bytes } : failedWith({ reason: "scriptUnverified" })
}

/**
 * Read whole before a byte reaches the machine, so a cut-off download can never
 * run as a shorter script, and checked against the sha256 the control plane
 * states beside it. A redirect is refused: the code is redeemed where it was
 * minted.
 */
export async function fetchConnectScript(
  controlPlaneUrl: string,
  options: { readonly fetch?: ScriptFetch; readonly log?: (message: string) => void } = {},
): Promise<ConnectScript> {
  const fetchImpl = options.fetch ?? noConnectionReuseFetch
  try {
    const script = await withDeadlineSignal(SCRIPT_DEADLINE_MS, async (signal) => {
      const response = await fetchImpl(new URL(CONNECT_SCRIPT_PATH, controlPlaneUrl), { signal, redirect: "error", cache: "no-store" })
      if (response.status === 200) return await readScript(response)
      options.log?.(`connect script answered ${String(response.status)}`)
      return failedWith({ reason: "scriptUnavailable" })
    })
    if (script.kind === "failed" && script.failure.reason === "scriptUnverified") options.log?.("connect script did not match its stated sha256")
    return script
  } catch (error) {
    options.log?.(`connect script download failed: ${String(error)}`)
    return failedWith({ reason: "scriptUnavailable" })
  }
}

function installStep(line: string): InstallStep | undefined {
  const match = STEP.exec(line)
  if (!match?.[1] || !match[2] || !match[3]) return undefined
  return { index: Number(match[1]), total: Number(match[2]), title: match[3] }
}

export async function installOverSsh(input: {
  readonly tools: SshTools
  readonly target: SshTarget
  readonly code: string
  readonly script: Buffer
  readonly signal: AbortSignal
  readonly onStep: (step: InstallStep) => void
}): Promise<InstallOutcome> {
  let stepsSeen = 0
  const exit = await runSshTool(input.tools, "ssh", sshArgv(input.target, installCommand(input.target.folder, input.code)), {
    input: input.script,
    signal: input.signal,
    onLine: (line) => {
      const step = installStep(line)
      if (!step) return
      stepsSeen += 1
      input.onStep(step)
    },
  })
  if (input.signal.aborted) return { kind: "cancelled" }
  if (exit.kind === "missing") return failedWith({ reason: "sshMissing" })
  if (exit.code === 0) return { kind: "finished" }
  input.tools.log?.(`install over ssh exited ${String(exit.code)}: ${exit.lastLine ?? ""}`)
  if (exit.code === FOLDER_MISSING_EXIT) return failedWith({ reason: "folderMissing" })
  if (exit.code === 255 || exit.code === null) {
    const reason = sshFailure(exit.stderr)
    return failedWith({ reason: reason === "unreachable" && stepsSeen > 0 ? "disconnected" : reason })
  }
  return failedWith({ reason: "remote", ...(exit.lastLine ? { line: exit.lastLine } : {}) })
}
