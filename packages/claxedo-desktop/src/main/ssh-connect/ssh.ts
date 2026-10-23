import { spawn as nodeSpawn } from "node:child_process"
import { homedir } from "node:os"
import { readField } from "@claxedo/helpers/readers"
import { shellQuote } from "@claxedo/helpers/shell"

export type SshTarget = {
  readonly destination: string
  readonly port?: number
  readonly identityFile?: string
  readonly folder?: string
}

export type SshFailureReason =
  | "invalidTarget"
  | "sshMissing"
  | "keyMissing"
  | "unreachable"
  | "authRefused"
  | "hostKeyChanged"
  | "hostKeyNotRecorded"
  | "unsupportedOs"
  | "folderMissing"
  | "scriptUnavailable"
  | "scriptUnverified"
  | "unavailable"
  | "disconnected"
  | "remote"

export type SshFailure = { readonly reason: SshFailureReason; readonly line?: string; readonly os?: string }

export type SshTools = {
  readonly ssh: string
  readonly sshKeygen: string
  readonly spawn?: typeof nodeSpawn
  readonly log?: (message: string) => void
}

export const SYSTEM_SSH_TOOLS: SshTools = { ssh: "ssh", sshKeygen: "ssh-keygen" }

const USER = /^[A-Za-z0-9_][A-Za-z0-9._+\\-]{0,63}$/
const HOST = /^[A-Za-z0-9_][A-Za-z0-9._:%-]{0,252}$/
const CONTROL = /[\u0000-\u001f\u007f]/
const PATH_LIMIT = 4096
const CONNECT_TIMEOUT_S = 15
const LINE_LIMIT = 240
const TAIL_LINES = 40
const OUTPUT_LIMIT = 64 * 1024

function readDestination(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const destination = value.trim()
  const at = destination.lastIndexOf("@")
  if (at !== -1 && !USER.test(destination.slice(0, at))) return undefined
  return HOST.test(destination.slice(at + 1)) ? destination : undefined
}

function readPort(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : null
}

function readPath(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== "string" || CONTROL.test(value) || value.length > PATH_LIMIT) return null
  return value.trim() || undefined
}

function resolveKeyFile(path: string): string {
  return path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path
}

/** `[user@]host` resolved through the person's own ssh config; a leading `-` never reaches ssh as an option. */
export function readSshTarget(value: unknown): SshTarget | undefined {
  const destination = readDestination(readField(value, "destination"))
  const port = readPort(readField(value, "port"))
  const identityFile = readPath(readField(value, "identityFile"))
  const folder = readPath(readField(value, "folder"))
  if (!destination || port === null || identityFile === null || folder === null) return undefined
  return {
    destination,
    ...(port ? { port } : {}),
    ...(identityFile ? { identityFile: resolveKeyFile(identityFile) } : {}),
    ...(folder ? { folder } : {}),
  }
}

/** BatchMode: a password or passphrase prompt would wait on a terminal Electron main does not have. */
export function sshOptions(target: SshTarget, hostKeyChecking: "yes" | "accept-new" = "yes"): string[] {
  return [
    "-T",
    "-a",
    "-x",
    "-o", "BatchMode=yes",
    "-o", "ClearAllForwardings=yes",
    "-o", `StrictHostKeyChecking=${hostKeyChecking}`,
    "-o", `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    ...(target.port ? ["-p", String(target.port)] : []),
    ...(target.identityFile ? ["-i", target.identityFile] : []),
  ]
}

export function sshArgv(target: SshTarget, remoteCommand: string, options: readonly string[] = sshOptions(target)): string[] {
  return [...options, "--", target.destination, remoteCommand]
}

export const PROBE_COMMAND = "uname -sm"

export const FOLDER_MISSING_EXIT = 66

const INSTALL_IN_FOLDER = `f=$1; shift; case $f in "~") f=$HOME ;; "~/"*) f=$HOME/\${f#"~/"} ;; esac; cd "$f" 2>/dev/null || exit ${FOLDER_MISSING_EXIT}; exec sh -s -- "$@"`

/**
 * The remote login shell may be bash, zsh or fish, so it is handed only
 * single-quoted words; the folder and code are arguments to a POSIX `sh`, which
 * reads the connect script from this session's stdin.
 */
export function installCommand(folder: string | undefined, code: string): string {
  return ["sh", "-c", shellQuote(INSTALL_IN_FOLDER), "sh", shellQuote(folder ?? "~"), shellQuote(code)].join(" ")
}

export type ToolExit =
  | { readonly kind: "missing" }
  | { readonly kind: "exited"; readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly lastLine?: string }

export type ToolRun = {
  readonly input?: Buffer
  readonly onLine?: (line: string) => void
  readonly signal?: AbortSignal
  readonly deadlineMs?: number
}

export function cleanLine(raw: string): string {
  const text = raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f]/g, "").trim()
  return text.length > LINE_LIMIT ? `${text.slice(0, LINE_LIMIT - 1)}…` : text
}

function outputLines(onLine: (raw: string) => void) {
  let pending = ""
  return {
    push(chunk: Buffer) {
      const parts = (pending + chunk.toString("utf8")).split("\n")
      pending = parts.pop() ?? ""
      for (const part of parts) onLine(part)
    },
    flush() {
      if (pending) onLine(pending)
      pending = ""
    },
  }
}

function outputCollector(onLine: ToolRun["onLine"]) {
  const tail: string[] = []
  const text = { stdout: "", stderr: "" }
  const keep = (stream: "stdout" | "stderr") => (raw: string) => {
    text[stream] = `${text[stream]}${raw}\n`.slice(-OUTPUT_LIMIT)
    const line = cleanLine(raw)
    if (!line) return
    tail.push(line)
    if (tail.length > TAIL_LINES) tail.shift()
    onLine?.(line)
  }
  const readers = { stdout: outputLines(keep("stdout")), stderr: outputLines(keep("stderr")) }
  return {
    readers,
    finish: () => {
      readers.stdout.flush()
      readers.stderr.flush()
      return { ...text, ...(tail.length ? { lastLine: tail[tail.length - 1] } : {}) }
    },
  }
}

/** Runs `ssh` or `ssh-keygen` with no shell between: every argument reaches the program as one word. */
export function runSshTool(tools: SshTools, program: "ssh" | "sshKeygen", args: readonly string[], run: ToolRun = {}): Promise<ToolExit> {
  const spawn = tools.spawn ?? nodeSpawn
  return new Promise((resolve) => {
    const child = spawn(tools[program], [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    const output = outputCollector(run.onLine)
    const stop = () => child.kill("SIGTERM")
    const timer = run.deadlineMs ? setTimeout(stop, run.deadlineMs) : undefined
    run.signal?.addEventListener("abort", stop, { once: true })
    let settled = false
    const settle = (exit: ToolExit) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      run.signal?.removeEventListener("abort", stop)
      resolve(exit)
    }
    child.stdout?.on("data", (chunk: Buffer) => output.readers.stdout.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => output.readers.stderr.push(chunk))
    child.once("error", (error: NodeJS.ErrnoException) => {
      settle(error.code === "ENOENT" ? { kind: "missing" } : { kind: "exited", code: null, ...output.finish() })
    })
    child.once("close", (code) => settle({ kind: "exited", code, ...output.finish() }))
    child.stdin?.on("error", () => undefined)
    child.stdin?.end(run.input)
  })
}

/** OpenSSH exits 255 for its own failures; these are the lines it prints for each in 8.x and 9.x. */
export function sshFailure(stderr: string): SshFailureReason {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|has changed and you have requested strict checking/.test(stderr)) return "hostKeyChanged"
  if (/Permission denied|Too many authentication failures|No more authentication methods/i.test(stderr)) return "authRefused"
  return "unreachable"
}

export function isUnknownHostKey(stderr: string): boolean {
  return sshFailure(stderr) === "unreachable" && /host key is known for|Host key verification failed/.test(stderr)
}
