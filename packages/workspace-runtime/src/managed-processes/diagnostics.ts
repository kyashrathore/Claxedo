import type { Pty } from "../pty/index"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Process } from "./schema"

const execFileAsync = promisify(execFile)

const trim = (value: string) => value.trim()
const tag = (value: string) => value.replace(/[^a-z0-9_-]+/gi, "_")

const marker = (command: string, key: string) => {
  const match = command.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`))
  return match?.[1]?.trim()
}

const short = (command: string) => {
  const idx = command.search(/\s[A-Z][A-Z0-9_]*=[^\s]+/)
  if (idx === -1) return trim(command)
  return trim(command.slice(0, idx))
}

const head = (command: string) => trim(command).match(/^(".*?"|'.*?'|\S+)/)?.[1]?.replace(/^["']|["']$/g, "") ?? ""
const leaf = (command: string) => head(command).split(/[\\/]/).at(-1) ?? ""
const bad = (state: string) => /[TZU]/.test(state)
const desktop = (command: string) => /\/(OpenCode|Claxedo)[ .].*\.app\/|\/MacOS\/(OpenCode|Claxedo)\b/i.test(head(command))
const branded = (command: string) =>
  /^(?:opencode|claxedo)(?:-cli)?$/i.test(leaf(command)) ||
  (/\/(?:opencode|claxedo)(?:-cli)?$/i.test(head(command)) && !foreignApp(command)) ||
  /\/dist-serve\/serve-entry\.js\b/i.test(command)
const foreignApp = (command: string) =>
  /\.app\//i.test(command) && !desktop(command)
const SEVEN_DAYS_S = 7 * 24 * 3600

type Input = {
  directory: string
  ptys: Array<Pty.Info & { subscribers?: number; managed?: boolean; orphanTimerActive?: boolean }>
  configs: Array<Process.ProcessConfig>
  processes: Array<Process.ManagedProcess>
  os: Array<Process.DiagnosticOsProcess>
  server: Process.DiagnosticSnapshot["server"]
}

type Bucket = Process.DiagnosticSummaryBucket
type Owner = {
  key: string
  kind: Process.DiagnosticOwnerKind
  current: boolean
  leaked: boolean
  name?: string
}

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
  try {
    const { stdout } = await execFileAsync(cmd[0]!, cmd.slice(1), { maxBuffer: 50 * 1024 * 1024 })
    return stdout
  } catch {
    return ""
  }
}

function which(name: string): string | undefined {
  try {
    const { execSync } = require("child_process") as typeof import("child_process")
    const result = execSync(`which ${name} 2>/dev/null`, { encoding: "utf-8", timeout: 3000 }).trim()
    return result || undefined
  } catch {
    return undefined
  }
}

function bin(name: string, fallback?: string) {
  return which(name) ?? fallback ?? name
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

function stateStatus(state: string, reasons: string[]) {
  if (reasons.includes("dead-port") || reasons.includes("missing-pty")) return "stale" as const
  if (reasons.includes("bad-state") || reasons.includes("long-running")) return "suspect" as const
  return "active" as const
}

function bucket(groups: Array<Process.DiagnosticGroup>): Bucket {
  return {
    groups: groups.length,
    rows: groups.reduce((sum, group) => sum + group.children.length, 0),
    cpu_percent: groups.reduce((sum, group) => sum + group.cpu_percent, 0),
    rss_kb: groups.reduce((sum, group) => sum + group.rss_kb, 0),
    hidden_children: groups.reduce((sum, group) => sum + group.hidden_children, 0),
    problem_children: groups.reduce((sum, group) => sum + group.problem_children, 0),
  }
}

function groupStatus(rows: Array<Process.DiagnosticOsProcess>) {
  return rows.some((row) => row.status === "stale")
    ? "stale"
    : rows.some((row) => row.status === "suspect")
      ? "suspect"
      : "active"
}

function root(rows: Array<Process.DiagnosticOsProcess>, pid: Map<number, Process.DiagnosticOsProcess>) {
  return [...rows]
    .sort((a, b) => {
      const ah = pid.has(a.ppid) ? 1 : 0
      const bh = pid.has(b.ppid) ? 1 : 0
      if (ah !== bh) return ah - bh
      return b.rss_kb - a.rss_kb || b.cpu_percent - a.cpu_percent || a.pid - b.pid
    })[0]
}

function depth(row: Process.DiagnosticOsProcess, rows: Map<number, Process.DiagnosticOsProcess>) {
  let n = 0
  let cur = row
  const seen = new Set<number>()
  while (rows.has(cur.ppid) && !seen.has(cur.ppid)) {
    seen.add(cur.ppid)
    cur = rows.get(cur.ppid)!
    n += 1
  }
  return n
}

function title(input: {
  kind: Process.DiagnosticOwnerKind
  key: string
  row: Process.DiagnosticOsProcess
  cfg: Map<string, Process.ProcessConfig>
  pty: Map<string, Input["ptys"][number]>
}) {
  if (input.kind === "managed_process" && input.row.process_id) {
    return input.cfg.get(input.row.process_id)?.name || input.row.process_name || input.row.command_short
  }
  if (input.kind === "mcp_server") return input.row.mcp_name || `MCP ${input.row.pid}`
  if (input.kind === "tab") {
    return (
      (input.row.tracked_pty_id && input.pty.get(input.row.tracked_pty_id)?.title) ||
      input.row.tab_id ||
      input.row.terminal_id ||
      input.row.command_short
    )
  }
  if (input.kind === "server") return "Current server"
  if (input.kind === "app") return "Current app"
  if (input.kind === "external") {
    return input.row.port ? `Other server on :${input.row.port}` : `Other server ${input.row.pid}`
  }
  if (input.row.port) return `Leaked server on :${input.row.port}`
  if (input.row.terminal_id) return `Leaked terminal ${input.row.terminal_id}`
  if (input.row.process_id) return `Leaked process ${input.row.process_id}`
  return `Leaked process ${input.row.pid}`
}

function classify(
  row: Process.DiagnosticOsProcess,
  refs: {
    directory: string
    workspaceId?: string
    listening: Set<number>
    serverPid?: number
    trackedPtys: Set<string>
    trackedProcs: Set<string>
    mcp: Map<number, string>
  },
  pid: Map<number, Process.DiagnosticOsProcess>,
  memo: Map<number, Owner | null>,
  seen = new Set<number>(),
): Owner | undefined {
  const hit = memo.get(row.pid)
  if (hit !== undefined) return hit || undefined
  if (seen.has(row.pid)) return undefined
  seen.add(row.pid)
  const same = !row.workspace_id || row.workspace_id === refs.directory || row.workspace_id === refs.workspaceId
  const server = refs.serverPid !== undefined && row.pid === refs.serverPid
  const trackedPty = row.tracked_pty_id || (row.terminal_id && refs.trackedPtys.has(row.terminal_id) ? row.terminal_id : undefined)
  const trackedProc = same
    ? row.tracked_process_id || (row.process_id && refs.trackedProcs.has(row.process_id) ? row.process_id : undefined)
    : undefined
  const activePort = row.port !== undefined && refs.listening.has(row.port)
  const other = !same || (!trackedPty && !trackedProc && row.port !== undefined && activePort && row.pid !== refs.serverPid)
  const keep = (owner?: Owner) => {
    memo.set(row.pid, owner ?? null)
    return owner
  }

  if (!same) {
    const base = row.port ?? row.process_id ?? row.terminal_id ?? row.pid
    return keep({ key: `external:${tag(String(base))}`, kind: "external" as const, current: false, leaked: false })
  }

  if (server) {
    return keep({ key: "server:current", kind: "server" as const, current: true, leaked: false })
  }
  if (foreignApp(row.command)) {
    return keep(undefined)
  }
  const name = refs.mcp.get(row.pid)
  if (name) {
    return keep({ key: `mcp:${tag(name)}`, kind: "mcp_server" as const, current: true, leaked: false, name })
  }
  if (trackedProc) {
    return keep({ key: `managed:${trackedProc}`, kind: "managed_process" as const, current: true, leaked: false })
  }
  if (trackedPty || row.tab_id || row.terminal_id) {
    if (trackedPty) {
      return keep({ key: `tab:${trackedPty}`, kind: "tab" as const, current: true, leaked: false })
    }
    if (other) {
      const base = row.port ?? row.terminal_id ?? row.tab_id ?? row.pid
      return keep({ key: `external:${tag(String(base))}`, kind: "external" as const, current: false, leaked: false })
    }
    const base = row.port ?? row.terminal_id ?? row.tab_id ?? row.pid
    return keep({ key: `leak:${tag(String(base))}`, kind: "leaked_server" as const, current: false, leaked: true })
  }
  if (desktop(row.command_short)) {
    return keep({ key: "app:current", kind: "app" as const, current: true, leaked: false })
  }

  const parent = pid.get(row.ppid)
  const base = parent ? classify(parent, refs, pid, memo, seen) : undefined
  if (base?.kind === "managed_process") return keep(base)
  if (base?.kind === "mcp_server") return keep(base)
  if (base?.kind === "tab") return keep(base)
  if (base?.kind === "server") return keep(base)
  if (base?.kind === "external") return keep(base)
  if (base?.kind === "leaked_server") return keep(base)
  if (base?.kind === "app" && desktop(row.command_short)) {
    return keep(base)
  }

  if (row.process_id) {
    if (other) {
      return keep({ key: `external:proc:${tag(row.process_id)}`, kind: "external" as const, current: false, leaked: false })
    }
    return keep({ key: `leak:proc:${tag(row.process_id)}`, kind: "leaked_server" as const, current: false, leaked: true })
  }
  if (other) {
    const base = row.port ?? row.pgid ?? row.pid
    return keep({ key: `external:${tag(String(base))}`, kind: "external" as const, current: false, leaked: false })
  }
  if (branded(row.command_short) || row.port !== undefined) {
    const base = row.port ?? row.pgid ?? row.pid
    return keep({ key: `leak:${tag(String(base))}`, kind: "leaked_server" as const, current: false, leaked: true })
  }
  return keep(undefined)
}

export function parseDiagnosticPs(
  input: string,
  refs: {
    directory: string
    workspaceId?: string
    ptys: Array<Pty.Info>
    processes: Array<Process.ManagedProcess>
    listening: Set<number>
    serverPid?: number
    mcp?: Array<{ name: string; pid: number }>
  },
) {
  const ptyIds = new Set(refs.ptys.map((pty) => pty.id))
  const ptyPid = new Map(refs.ptys.map((pty) => [pty.pid, pty.id] as const))
  const procIds = new Set(refs.processes.map((proc) => proc.configId))
  const mcp = new Map((refs.mcp ?? []).map((item) => [item.pid, item.name] as const))
  const rows = input
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
      const processId = marker(command, "OPENCODE_PROCESS_ID")
      const processName = marker(command, "OPENCODE_PROCESS")
      const terminalId = marker(command, "CLAXEDO_TERMINAL_ID")
      const tabId = marker(command, "CLAXEDO_TAB_ID")
      const workspaceId = marker(command, "CLAXEDO_WORKSPACE_ID")
      const agent = marker(command, "CLAXEDO_AGENT")
      const rawPort = marker(command, "CLAXEDO_PORT")
      const port = rawPort ? Number(rawPort) : undefined
      const same = !workspaceId || workspaceId === refs.directory || workspaceId === refs.workspaceId
      const trackedPty = same && terminalId && ptyIds.has(terminalId) ? terminalId : same ? ptyPid.get(pid) : undefined
      const trackedProcess = same && processId && procIds.has(processId) ? processId : undefined
      const commandShort = short(command)
      const isDesktop = desktop(commandShort)
      const other =
        !trackedPty &&
        Number.isFinite(port) &&
        port !== undefined &&
        refs.listening.has(port) &&
        refs.serverPid !== undefined &&
        pid !== refs.serverPid

      const reasons: string[] = []
      if (Number.isFinite(port) && port !== undefined && !refs.listening.has(port)) reasons.push("dead-port")
      if (terminalId && !trackedPty && !other) reasons.push("missing-pty")
      if (bad(match[4] ?? "")) reasons.push("bad-state")
      if (parseElapsed(match[7] ?? "") >= SEVEN_DAYS_S) reasons.push("long-running")

      return [
        Process.DiagnosticOsProcess.parse({
          pid,
          ppid,
          pgid,
          state: match[4],
          cpu_percent: Number.isFinite(cpu) ? cpu : 0,
          rss_kb: Math.max(0, Math.round(rss)),
          elapsed: match[7],
          kind: isDesktop ? "desktop" : processId ? "process" : "terminal",
          command,
          command_short: commandShort,
          process_id: processId,
          process_name: processName,
          terminal_id: terminalId,
          tab_id: tabId,
          workspace_id: workspaceId,
          agent,
          port: Number.isFinite(port) ? port : undefined,
          mcp_name: mcp.get(pid),
          tracked_pty_id: trackedPty,
          tracked_process_id: trackedProcess,
          status: stateStatus(match[4] ?? "", reasons),
          reasons,
        }),
      ]
    })

  const pid = new Map(rows.map((row) => [row.pid, row] as const))
  const memo = new Map<number, Owner | null>()

  return rows.flatMap((row) => {
    const owner = classify(
      row,
      {
        directory: refs.directory,
        workspaceId: refs.workspaceId,
        listening: refs.listening,
        serverPid: refs.serverPid,
        trackedPtys: ptyIds,
        trackedProcs: procIds,
        mcp,
      },
      pid,
      memo,
    )
    if (!owner) return []
    return [
      Process.DiagnosticOsProcess.parse({
        ...row,
        mcp_name: owner.name ?? row.mcp_name,
        owner_key: owner.key,
        owner_kind: owner.kind,
        current: owner.current,
        leaked: owner.leaked,
        hidden_by_default: false,
        depth: 0,
      }),
    ]
  })
}

export function groupDiagnostics(input: Input) {
  const cfg = new Map(input.configs.map((item) => [item.id, item] as const))
  const pty = new Map(input.ptys.map((item) => [item.id, item] as const))
  const byKey = new Map<string, Array<Process.DiagnosticOsProcess>>()

  for (const row of input.os) {
    if (!row.owner_key || !row.owner_kind) continue
    if (!byKey.has(row.owner_key)) byKey.set(row.owner_key, [])
    byKey.get(row.owner_key)!.push(row)
  }

  const groups = [...byKey.entries()].map(([key, rows]) => {
    const pid = new Map(rows.map((row) => [row.pid, row] as const))
    const children = rows
      .map((row) =>
        Process.DiagnosticOsProcess.parse({
          ...row,
          depth: depth(row, pid),
        }),
      )
      .sort((a, b) => a.depth - b.depth || b.rss_kb - a.rss_kb || b.cpu_percent - a.cpu_percent || a.pid - b.pid)
      .map((row) =>
        Process.DiagnosticOsProcess.parse({
          ...row,
          hidden_by_default: row.depth > 0 && row.status === "active",
        }),
      )

    const lead = root(children, new Map(children.map((row) => [row.pid, row] as const)))!
    const ports = [...new Set(children.flatMap((row) => (row.port !== undefined ? [row.port] : [])))].sort((a, b) => a - b)
    const status = groupStatus(children)
    const kind = lead.owner_kind!
    const group = Process.DiagnosticGroup.parse({
      key,
      kind,
      title: title({ kind, key, row: lead, cfg, pty }),
      status,
      cpu_percent: children.reduce((sum, row) => sum + row.cpu_percent, 0),
      rss_kb: children.reduce((sum, row) => sum + row.rss_kb, 0),
      ports,
      pid: lead.pid,
      terminal_id: lead.tracked_pty_id || lead.terminal_id,
      process_id: lead.tracked_process_id || lead.process_id,
      tab_id: lead.tab_id,
      current: children.some((row) => row.current),
      leaked: children.some((row) => row.leaked),
      hidden_children: children.filter((row) => row.hidden_by_default).length,
      problem_children: children.filter((row) => row.depth > 0 && !row.hidden_by_default).length,
      children,
      target: {
        group_key: key,
        pid: lead.pid,
        scope: "pid",
      },
    })
    return group
  })

  const owners = groups
    .filter((group) => group.current && group.kind !== "external" && !group.leaked)
    .sort((a, b) => {
      const rank = (kind: Process.DiagnosticOwnerKind) => {
        if (kind === "managed_process") return 0
        if (kind === "tab") return 1
        if (kind === "mcp_server") return 2
        if (kind === "server") return 3
        if (kind === "app") return 4
        return 5
      }
      if (rank(a.kind) !== rank(b.kind)) return rank(a.kind) - rank(b.kind)
      return b.rss_kb - a.rss_kb || b.cpu_percent - a.cpu_percent || a.key.localeCompare(b.key)
    })

  const leaks = groups
    .filter((group) => group.kind === "leaked_server" || group.leaked)
    .sort((a, b) => b.rss_kb - a.rss_kb || b.cpu_percent - a.cpu_percent || a.key.localeCompare(b.key))

  const external = groups
    .filter((group) => group.kind === "external")
    .sort((a, b) => b.rss_kb - a.rss_kb || b.cpu_percent - a.cpu_percent || a.key.localeCompare(b.key))

  return {
    owners,
    leaks,
    summary: {
      current: bucket(owners),
      leaked: bucket(leaks),
      external: bucket(external),
    },
    os: groups.flatMap((group) => group.children),
  }
}

export function buildDiagnosticSnapshot(input: {
  directory: string
  listening: Set<number>
  server: Process.DiagnosticSnapshot["server"]
  ptys: Array<Pty.Info & { subscribers?: number; managed?: boolean; orphanTimerActive?: boolean }>
  configs: Array<Process.ProcessConfig>
  processes: Array<Process.ManagedProcess>
  os: Array<Process.DiagnosticOsProcess>
}) {
  const grouped = groupDiagnostics({
    directory: input.directory,
    ptys: input.ptys,
    configs: input.configs,
    processes: input.processes,
    os: input.os,
    server: input.server,
  })

  return Process.DiagnosticSnapshot.parse({
    directory: input.directory,
    listening_ports: [...input.listening].sort((a, b) => a - b),
    server: input.server,
    configs: input.configs,
    processes: input.processes,
    ptys: input.ptys,
    os: grouped.os,
    owners: grouped.owners,
    leaks: grouped.leaks,
    summary: grouped.summary,
    generated_at: Date.now(),
  })
}

export async function collectDiagnostics(input: {
  directory: string
  workspaceId?: string
  ptys: Array<Pty.Info & { subscribers?: number; managed?: boolean; orphanTimerActive?: boolean }>
  configs: Array<Process.ProcessConfig>
  processes: Array<Process.ManagedProcess>
  mcp?: Array<{ name: string; pid: number }>
}) {
  const pscmd = bin("ps", process.platform === "darwin" ? "/bin/ps" : undefined)
  const lsofcmd = bin("lsof", process.platform === "darwin" ? "/usr/sbin/lsof" : undefined)
  const [pstext, lsoftext] = await Promise.all([
    run([pscmd, "eww", "-axo", "pid,ppid,pgid,state,%cpu,rss,etime,command"]),
    run([lsofcmd, "-nP", "-iTCP", "-sTCP:LISTEN"]),
  ])

  const listening = parseListeningPorts(lsoftext)
  const mem = process.memoryUsage()
  const server = {
    pid: process.pid,
    rss_kb: Math.round(mem.rss / 1024),
    heap_used_kb: Math.round(mem.heapUsed / 1024),
    heap_total_kb: Math.round(mem.heapTotal / 1024),
    uptime_s: Math.round(process.uptime()),
  }
  const parsed = parseDiagnosticPs(pstext, {
    directory: input.directory,
    workspaceId: input.workspaceId,
    ptys: input.ptys,
    processes: input.processes,
    listening,
    serverPid: process.pid,
    mcp: input.mcp,
  })
  return buildDiagnosticSnapshot({
    directory: input.directory,
    listening,
    server,
    configs: input.configs,
    processes: input.processes,
    ptys: input.ptys,
    os: parsed,
  })
}

export async function terminateDiagnostic(
  input: Process.DiagnosticTerminateInput,
  snapshot?: Pick<Process.DiagnosticSnapshot, "owners" | "leaks">,
) {
  const signal = input.signal ?? "SIGTERM"
  if (input.group_key) {
    const group =
      snapshot?.leaks.find((item) => item.key === input.group_key) ||
      snapshot?.owners.find((item) => item.key === input.group_key)
    if (!group) return false
    const ids = [...new Set(group.children.map((row) => row.pid).filter((pid) => Number.isFinite(pid) && pid > 0))]
    for (const id of ids) {
      try {
        process.kill(id, signal)
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code !== "ESRCH") throw err
      }
    }
    return true
  }
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
