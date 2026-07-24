import { execFileSync, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import { app } from "electron"
import treeKill from "tree-kill"

import { IS_PACKAGED, WSL_ENABLED_KEY } from "./constants"
import { registerOwnedSidecar } from "./diagnostics/sidecar-owner"
import { store } from "./store"

const CLI_INSTALL_DIR = ".opencode/bin"
const CLI_BINARY_NAME = "opencode"

export type ServerConfig = {
  hostname?: string
  port?: number
}

export type Config = {
  server?: ServerConfig
}

export type TerminatedPayload = { code: number | null; signal: number | null }

export type CommandEvent =
  | { type: "stdout"; value: string }
  | { type: "stderr"; value: string }
  | { type: "error"; value: string }
  | { type: "terminated"; value: TerminatedPayload }
  | { type: "sqlite"; value: SqliteMigrationProgress }

export type SqliteMigrationProgress = { type: "InProgress"; value: number } | { type: "Done" }

const root = dirname(fileURLToPath(import.meta.url))
export { configureSidecarProcessObserver } from "./diagnostics/sidecar-owner"
export type { SidecarProcessObserver } from "./diagnostics/sidecar-owner"

export function getSidecarPath() {
  const suffix = process.platform === "win32" ? ".exe" : ""
  const path = IS_PACKAGED
    ? join(process.resourcesPath, `opencode-cli${suffix}`)
    : join(root, "../../resources", `opencode-cli${suffix}`)
  return path
}

export async function getConfig(): Promise<Config | null> {
  const { events } = spawnCommand("debug config", {})
  let output = ""

  await new Promise<void>((resolve) => {
    events.on("stdout", (line: string) => {
      output += line
    })
    events.on("stderr", (line: string) => {
      output += line
    })
    events.on("terminated", () => resolve())
    events.on("error", () => resolve())
  })

  try {
    return JSON.parse(output) as Config
  } catch {
    return null
  }
}

export async function installCli(): Promise<string> {
  if (process.platform === "win32") {
    throw new Error("CLI installation is only supported on macOS & Linux")
  }

  const sidecar = getSidecarPath()
  const scriptPath = join(app.getAppPath(), "install")
  const script = readFileSync(scriptPath, "utf8")
  const tempScript = join(tmpdir(), "opencode-install.sh")

  writeFileSync(tempScript, script, "utf8")
  chmodSync(tempScript, 0o755)

  const cmd = spawn(tempScript, ["--binary", sidecar], { stdio: "pipe" })
  return await new Promise<string>((resolve, reject) => {
    cmd.on("exit", (code: number | null) => {
      try {
        unlinkSync(tempScript)
      } catch {}
      if (code === 0) {
        const installPath = getCliInstallPath()
        if (installPath) return resolve(installPath)
        return reject(new Error("Could not determine install path"))
      }
      reject(new Error("Install script failed"))
    })
  })
}

export function syncCli() {
  if (!IS_PACKAGED) return
  const installPath = getCliInstallPath()
  if (!installPath) return

  let version = ""
  try {
    version = execFileSync(installPath, ["--version"]).toString().trim()
  } catch {
    return
  }

  const cli = parseVersion(version)
  const appVersion = parseVersion(app.getVersion())
  if (!cli || !appVersion) return
  if (compareVersions(cli, appVersion) >= 0) return
  void installCli().catch(() => undefined)
}

export function spawnCommand(
  args: string,
  extraEnv: Record<string, string>,
  options: { owned?: boolean } = {},
) {
  const base = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
  const envs = {
    ...base,
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_CLIENT: "desktop",
    XDG_STATE_HOME: app.getPath("userData"),
    ...(options.owned
      ? { BUN_OPTIONS: [base.BUN_OPTIONS, "--smol"].filter(Boolean).join(" ") }
      : {}),
    ...(options.owned && process.platform === "win32" && isWslEnabled()
      ? { CLAXEDO_DIAGNOSTICS_WSL_HANDSHAKE: crypto.randomUUID() }
      : {}),
    ...extraEnv,
  }

  const { cmd, cmdArgs } = buildCommand(args, envs)
  const child = spawn(cmd, cmdArgs, {
    env: envs,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (options.owned && child.pid) recordSidecarOwner(child.pid)

  const events = new EventEmitter()
  let exited = false
  let stopping: Promise<void> | undefined
  const stop = (signal: "SIGTERM" | "SIGKILL") => {
    if (!child.pid || exited) return Promise.resolve()
    return killTree(child.pid, signal)
  }
  const owner =
    options.owned && child.pid
      ? registerOwnedSidecar({
          pid: child.pid,
          stopGracefully: () => stop("SIGTERM"),
          killOwnedTree: () => stop("SIGKILL"),
        })
      : undefined
  const exit = new Promise<TerminatedPayload>((resolve) => {
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      exited = true
      if (options.owned && child.pid) clearSidecarOwner(child.pid)
      owner?.exit({
        reason: "exited",
        ...(typeof code === "number" ? { exitCode: code } : {}),
      })
      resolve({ code: code ?? null, signal: null })
    })
    child.on("error", (error: Error) => {
      exited = true
      if (options.owned && child.pid) clearSidecarOwner(child.pid)
      owner?.exit({ reason: "error" })
      console.error(`[cli] Process error: ${error.message}`)
      events.emit("error", error.message)
      resolve({ code: null, signal: null })
    })
  })

  const stdout = child.stdout
  const stderr = child.stderr

  if (stdout) {
    readline.createInterface({ input: stdout }).on("line", (line: string) => {
      if (handleSqliteProgress(events, line)) return
      events.emit("stdout", `${line}\n`)
    })
  }

  if (stderr) {
    readline.createInterface({ input: stderr }).on("line", (line: string) => {
      if (handleSqliteProgress(events, line)) return
      const wslRoot = parseWslDiagnosticsHandshake(
        line,
        envs.CLAXEDO_DIAGNOSTICS_WSL_HANDSHAKE,
      )
      if (wslRoot) {
        owner?.wslRoot?.(wslRoot)
        return
      }
      events.emit("stderr", `${line}\n`)
    })
  }

  exit.then((payload) => {
    events.emit("terminated", payload)
  })

  const kill = () => {
    if (stopping) return stopping
    if (!child.pid || exited) return Promise.resolve()
    stopping = (async () => {
      await killTree(child.pid!, "SIGTERM")
      const stopped = await Promise.race([
        exit.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ])
      if (stopped) return
      await killTree(child.pid!, "SIGKILL")
      await Promise.race([
        exit.then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ])
    })()
    return stopping
  }

  return { events, child: { kill }, exit }
}

export async function cleanupStaleSidecar() {
  const owner = readSidecarOwner()
  if (!owner) return
  if (!sidecarCommandMatches(owner)) {
    clearSidecarOwner(owner.pid)
    return
  }
  await killTree(owner.pid, "SIGTERM")
  clearSidecarOwner(owner.pid)
}

function killTree(pid: number, signal: "SIGTERM" | "SIGKILL") {
  return new Promise<void>((resolve) => {
    treeKill(pid, signal, (error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ESRCH") {
        console.warn(`[cli] Failed to ${signal} sidecar process tree ${pid}: ${error.message}`)
      }
      resolve()
    })
  })
}

function sidecarOwnerFile() {
  return join(app.getPath("userData"), "sidecar-owner.json")
}

function recordSidecarOwner(pid: number) {
  mkdirSync(app.getPath("userData"), { recursive: true })
  writeFileSync(sidecarOwnerFile(), JSON.stringify({ pid, executable: getSidecarPath() }))
}

function readSidecarOwner() {
  try {
    const value = JSON.parse(readFileSync(sidecarOwnerFile(), "utf8")) as {
      pid?: unknown
      executable?: unknown
    }
    if (typeof value.pid !== "number" || typeof value.executable !== "string") return
    return { pid: value.pid, executable: value.executable }
  } catch {
    return
  }
}

function clearSidecarOwner(pid: number) {
  if (readSidecarOwner()?.pid !== pid) return
  try {
    unlinkSync(sidecarOwnerFile())
  } catch {}
}

function sidecarCommandMatches(owner: { pid: number; executable: string }) {
  if (process.platform === "win32") return false
  try {
    return execFileSync("ps", ["-p", String(owner.pid), "-o", "command="], { encoding: "utf8" })
      .includes(owner.executable)
  } catch {
    return false
  }
}

function handleSqliteProgress(events: EventEmitter, line: string) {
  const stripped = line.startsWith("sqlite-migration:") ? line.slice("sqlite-migration:".length).trim() : null
  if (!stripped) return false
  if (stripped === "done") {
    events.emit("sqlite", { type: "Done" })
    return true
  }
  const value = Number.parseInt(stripped, 10)
  if (!Number.isNaN(value)) {
    events.emit("sqlite", { type: "InProgress", value })
    return true
  }
  return false
}

function buildCommand(args: string, env: Record<string, string>) {
  if (process.platform === "win32" && isWslEnabled()) {
    const version = app.getVersion()
    const script = [
      "set -e",
      'BIN="$HOME/.opencode/bin/opencode"',
      'if [ ! -x "$BIN" ]; then',
      `  curl -fsSL https://opencode.ai/install | bash -s -- --version ${shellEscape(version)} --no-modify-path`,
      "fi",
      `printf '__CLAXEDO_DIAGNOSTICS_WSL__ %s %s %s\\n' ${shellEscape(env.CLAXEDO_DIAGNOSTICS_WSL_HANDSHAKE ?? "")} "$$" "$(awk '{print $22}' /proc/$$/stat)" >&2`,
      `${envPrefix(env)} exec "$BIN" ${args}`,
    ].join("\n")

    return { cmd: "wsl", cmdArgs: ["-e", "bash", "-lc", script] }
  }

  if (process.platform === "win32") {
    const sidecar = getSidecarPath()
    return { cmd: sidecar, cmdArgs: args.split(" ") }
  }

  const sidecar = getSidecarPath()
  const shell = process.env.SHELL || "/bin/sh"
  const line = shell.endsWith("/nu") ? `^\"${sidecar}\" ${args}` : `exec \"${sidecar}\" ${args}`
  return { cmd: shell, cmdArgs: ["-l", "-c", line] }
}

export function parseWslDiagnosticsHandshake(line: string, expected?: string) {
  if (!expected) return
  const match = /^__CLAXEDO_DIAGNOSTICS_WSL__ ([A-Za-z0-9-]{1,256}) ([1-9]\d*) ([1-9]\d*)$/.exec(line)
  if (!match || match[1] !== expected) return
  const pid = Number(match[2])
  if (!Number.isSafeInteger(pid)) return
  return { handshakeId: match[1], pid, startTicks: match[3]! }
}

function envPrefix(env: Record<string, string>) {
  const entries = Object.entries(env).map(([key, value]) => `${key}=${shellEscape(value)}`)
  return entries.join(" ")
}

function shellEscape(input: string) {
  if (!input) return "''"
  return `'${input.replace(/'/g, `'"'"'`)}'`
}

function getCliInstallPath() {
  const home = process.env.HOME
  if (!home) return null
  return join(home, CLI_INSTALL_DIR, CLI_BINARY_NAME)
}

function isWslEnabled() {
  return store.get(WSL_ENABLED_KEY) === true
}

function parseVersion(value: string) {
  const parts = value
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
  if (parts.some((part) => Number.isNaN(part))) return null
  return parts
}

function compareVersions(a: number[], b: number[]) {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left > right) return 1
    if (left < right) return -1
  }
  return 0
}
