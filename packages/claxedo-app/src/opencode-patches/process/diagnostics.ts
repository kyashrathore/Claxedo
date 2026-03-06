import type { Pty } from "@/pty"
import { Process } from "./process"

const trim = (value: string) => value.trim()

const marker = (command: string, key: string) => {
  const match = command.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`))
  return match?.[1]?.trim()
}

const short = (command: string) => {
  const idx = command.search(/\s[A-Z][A-Z0-9_]*=[^\s]+/)
  if (idx === -1) return trim(command)
  return trim(command.slice(0, idx))
}

const bad = (state: string) => /[TZU]/.test(state)
/** Match against the stripped command (no env vars) to avoid false positives. */
const desktopApp = (commandShort: string) =>
  /\/(OpenCode|Claxedo)[ .].*\.app\/|\/MacOS\/(OpenCode|Claxedo)\b/i.test(commandShort)

const SEVEN_DAYS_S = 7 * 24 * 3600

/** Parse ps `etime` format into seconds. Formats: `DD-HH:MM:SS`, `HH:MM:SS`, `MM:SS` */
export function parseElapsed(elapsed: string): number {
  const d = elapsed.match(/^(\d+)-(\d+):(\d+):(\d+)$/)
  if (d) return Number(d[1]) * 86400 + Number(d[2]) * 3600 + Number(d[3]) * 60 + Number(d[4])
  const h = elapsed.match(/^(\d+):(\d+):(\d+)$/)
  if (h) return Number(h[1]) * 3600 + Number(h[2]) * 60 + Number(h[3])
  const m = elapsed.match(/^(\d+):(\d+)$/)
  if (m) return Number(m[1]) * 60 + Number(m[2])
  return 0
}

async function run(cmd: string[]) {
  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = proc.stdout ? await new Response(proc.stdout).text() : ""
  await proc.exited.catch(() => 1)
  return stdout
}

export function parseListeningPorts(input: string) {
  const ports = new Set<number>()
  for (const line of input.split(/\r?\n/)) {
    const match = line.match(/:(\d+)\s+\(LISTEN\)\s*$/)
    if (!match) continue
    const port = Number(match[1])
    if (Number.isFinite(port)) ports.add(port)
  }
  return ports
}

export function parseDiagnosticPs(
  input: string,
  refs: {
    ptys: Array<Pty.Info>
    processes: Array<Process.ManagedProcess>
    listening: Set<number>
    serverPid?: number
  },
) {
  const ptyIds = new Set(refs.ptys.map((pty) => pty.id))
  const ptyPid = new Map(refs.ptys.map((pty) => [pty.pid, pty.id] as const))
  const procIds = new Set(refs.processes.map((proc) => proc.configId))

  return input
    .split(/\r?\n/)
    .map(trim)
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(
        /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/,
      )
      if (!match) return []

      const pid = Number(match[1])
      const ppid = Number(match[2])
      const pgid = Number(match[3])
      const cpu = Number(match[5])
      const rss = Number(match[6])
      if (![pid, ppid, pgid, cpu, rss].every(Number.isFinite)) return []

      const command = match[8] ?? ""
      const opencodeTerminal = marker(command, "OPENCODE_TERMINAL") === "1"
      const processId = marker(command, "OPENCODE_PROCESS_ID")
      const processName = marker(command, "OPENCODE_PROCESS")
      const terminalId = marker(command, "CLAXEDO_TERMINAL_ID")
      const tabId = marker(command, "CLAXEDO_TAB_ID")
      const workspaceId = marker(command, "CLAXEDO_WORKSPACE_ID")
      const agent = marker(command, "CLAXEDO_AGENT")
      const rawPort = marker(command, "CLAXEDO_PORT")
      const port = rawPort ? Number(rawPort) : undefined
      const trackedPty = terminalId && ptyIds.has(terminalId) ? terminalId : ptyPid.get(pid)
      const trackedProcess = processId && procIds.has(processId) ? processId : undefined
      const commandShort = short(command)
      const isDesktopApp = desktopApp(commandShort)
      const related =
        opencodeTerminal ||
        !!processId ||
        !!processName ||
        !!terminalId ||
        !!tabId ||
        !!workspaceId ||
        !!agent ||
        port !== undefined ||
        !!trackedPty ||
        !!trackedProcess ||
        isDesktopApp
      if (!related) return []

      // If the process has a CLAXEDO_PORT that's still listening but its terminal
      // isn't in our PTY list, it likely belongs to a different server instance.
      const ownedByOtherServer =
        !trackedPty &&
        Number.isFinite(port) &&
        port !== undefined &&
        refs.listening.has(port) &&
        refs.serverPid !== undefined &&
        pid !== refs.serverPid

      const reasons: string[] = []
      if (Number.isFinite(port) && port !== undefined && !refs.listening.has(port)) reasons.push("dead-port")
      if (terminalId && !trackedPty && !ownedByOtherServer) reasons.push("missing-pty")
      if (bad(match[4] ?? "")) reasons.push("bad-state")
      if (parseElapsed(match[7] ?? "") >= SEVEN_DAYS_S) reasons.push("long-running")

      const status: Process.DiagnosticStatus =
        reasons.includes("dead-port") || reasons.includes("missing-pty")
          ? "stale"
          : reasons.includes("bad-state") || reasons.includes("long-running")
            ? "suspect"
            : "active"

      return [
        Process.DiagnosticOsProcess.parse({
          pid,
          ppid,
          pgid,
          state: match[4],
          cpu_percent: Number.isFinite(cpu) ? cpu : 0,
          rss_kb: Math.max(0, Math.round(rss)),
          elapsed: match[7],
          kind: isDesktopApp ? "desktop" : processId ? "process" : "terminal",
          command,
          command_short: commandShort,
          process_id: processId,
          process_name: processName,
          terminal_id: terminalId,
          tab_id: tabId,
          workspace_id: workspaceId,
          agent,
          port: Number.isFinite(port) ? port : undefined,
          tracked_pty_id: trackedPty,
          tracked_process_id: trackedProcess,
          status,
          reasons,
        }),
      ]
    })
}

export async function collectDiagnostics(input: {
  directory: string
  ptys: Array<Pty.Info>
  configs: Array<Process.ProcessConfig>
  processes: Array<Process.ManagedProcess>
}) {
  const [ps, lsof] = await Promise.all([
    run(["ps", "eww", "-axo", "pid,ppid,pgid,state,%cpu,rss,etime,command"]),
    run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]),
  ])

  const listening = parseListeningPorts(lsof)
  const os = parseDiagnosticPs(ps, {
    ptys: input.ptys,
    processes: input.processes,
    listening,
    serverPid: process.pid,
  })

  const mem = process.memoryUsage()

  return Process.DiagnosticSnapshot.parse({
    directory: input.directory,
    listening_ports: [...listening].sort((a, b) => a - b),
    server: {
      pid: process.pid,
      rss_kb: Math.round(mem.rss / 1024),
      heap_used_kb: Math.round(mem.heapUsed / 1024),
      heap_total_kb: Math.round(mem.heapTotal / 1024),
      uptime_s: Math.round(process.uptime()),
    },
    configs: input.configs,
    processes: input.processes,
    ptys: input.ptys,
    os,
    generated_at: Date.now(),
  })
}

export async function terminateDiagnostic(input: Process.DiagnosticTerminateInput) {
  const signal = input.signal ?? "SIGTERM"
  if (input.pid) {
    try {
      if (input.scope === "group" && process.platform !== "win32") {
        process.kill(-input.pid, signal)
        return true
      }
      process.kill(input.pid, signal)
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== "ESRCH") throw err
    }
    return true
  }
  return false
}
