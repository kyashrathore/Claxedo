import type { Process } from "@claxedo/process/process"
import {
  cachedTerminalLogSummary,
  loadTerminalLogSummary,
} from "./terminal-log-summary"
import {
  cachedTerminalSessionPreview,
  loadTerminalSessionPreview,
} from "./terminal-session-preview"
import { terminalSessionSummary } from "./terminal-session-summary"
import { collapse, clip, formatMB, formatCPU } from "./text"

type Snapshot = Process.DiagnosticSnapshot

export const PROCESS_DIAGNOSIS_MODEL = {
  providerID: "openai",
  modelID: "gpt-5.3-codex",
} as const

export const PROCESS_DIAGNOSIS_SYSTEM = [
  "You are diagnosing OpenCode and Claxedo processes on the user's local machine.",
  "Respond in plain markdown, not JSON.",
  "Group related workloads by purpose.",
  "Explain which workloads should keep running, which are safe to close, and which need investigation.",
  "Prefer concrete, minimal recommendations.",
  "When useful, reference exact process_id, terminal_id, session_id, and pid values from the snapshot.",
].join(" ")

type ResourceRow = {
  title: string
  subtitle: string
  directory: string
  kind: "managed" | "terminal"
  processId?: string
  terminalId?: string
  cpu: number
  rssKb: number
  os: Snapshot["os"]
  status: string
}

const clipped = (value: string | undefined, max = 180) => clip(collapse(value), max)

function resources(snapshot: Snapshot): ResourceRow[] {
  const processById = new Map(snapshot.processes.map((item) => [item.configId, item] as const))
  const ptyById = new Map(snapshot.ptys.map((item) => [item.id, item] as const))
  const usedPtys = new Set<string>()
  const rows: ResourceRow[] = []

  for (const config of snapshot.configs) {
    const proc = processById.get(config.id)
    const pty = proc?.ptyId ? ptyById.get(proc.ptyId) : undefined
    if (pty?.id) usedPtys.add(pty.id)
    const related = snapshot.os.filter((row) => row.process_id === config.id || (!!proc?.ptyId && row.terminal_id === proc.ptyId))
    rows.push({
      title: config.name,
      subtitle: config.command,
      directory: config.cwd || snapshot.directory,
      kind: "managed",
      processId: config.id,
      terminalId: proc?.ptyId,
      cpu: related.reduce((sum, row) => sum + row.cpu_percent, 0),
      rssKb: related.reduce((sum, row) => sum + row.rss_kb, 0),
      os: related,
      status: proc?.status ?? "idle",
    })
  }

  for (const pty of snapshot.ptys) {
    if (usedPtys.has(pty.id)) continue
    const related = snapshot.os.filter((row) => row.terminal_id === pty.id || row.pid === pty.pid)
    rows.push({
      title: pty.title,
      subtitle: pty.command,
      directory: pty.cwd,
      kind: "terminal",
      terminalId: pty.id,
      cpu: related.reduce((sum, row) => sum + row.cpu_percent, 0),
      rssKb: related.reduce((sum, row) => sum + row.rss_kb, 0),
      os: related,
      status: pty.status,
    })
  }

  return rows
}

export async function buildProcessDiagnosisPrompt(input: {
  sdkUrl: string
  snapshot: Snapshot
}) {
  const rows = resources(input.snapshot)
  const ids = new Map(
    rows.flatMap((row) =>
      row.terminalId && row.directory
        ? [[row.terminalId, { terminalId: row.terminalId, directory: row.directory }] as const]
        : [],
    ),
  )

  const hints = new Map(
    await Promise.all(
      [...ids.values()].map(async (item) => {
        const [preview, log] = await Promise.all([
          loadTerminalSessionPreview(input.sdkUrl, item.terminalId).catch(() => cachedTerminalSessionPreview(input.sdkUrl, item.terminalId)),
          loadTerminalLogSummary(input.sdkUrl, item.terminalId, item.directory).catch(() =>
            cachedTerminalLogSummary(input.sdkUrl, item.terminalId, item.directory),
          ),
        ])
        return [
          item.terminalId,
          {
            preview: preview ?? undefined,
            summary: terminalSessionSummary(preview ?? undefined) ?? log ?? undefined,
          },
        ] as const
      }),
    ),
  )

  const mapped = new Set(rows.flatMap((row) => row.os.map((item) => item.pid)))
  const stray = input.snapshot.os.filter((row) => !mapped.has(row.pid))
  const totalRss = input.snapshot.os.reduce((sum, row) => sum + row.rss_kb, 0)
  const totalCpu = input.snapshot.os.reduce((sum, row) => sum + row.cpu_percent, 0)
  const stale = input.snapshot.os.filter((row) => row.status === "stale")
  const suspect = input.snapshot.os.filter((row) => row.status === "suspect")
  const tracked = rows
    .map((row) => {
      const context = row.terminalId ? hints.get(row.terminalId) : undefined
      const hint = context?.summary
      const meta = [
        `kind=${row.kind}`,
        `status=${row.status}`,
        `cpu=${formatCPU(row.cpu)}`,
        `rss=${formatMB(row.rssKb)}`,
        row.processId ? `process_id=${row.processId}` : "",
        row.terminalId ? `terminal_id=${row.terminalId}` : "",
        row.directory ? `dir=${clip(row.directory, 96)}` : "",
      ]
        .filter(Boolean)
        .join(" | ")

      const kids = row.os
        .slice(0, 6)
        .map(
          (item) =>
            `  - pid=${item.pid} ppid=${item.ppid} pgid=${item.pgid} status=${item.status} state=${item.state} cpu=${formatCPU(item.cpu_percent)} rss=${formatMB(item.rss_kb)} elapsed=${item.elapsed} cmd=${clip(item.command_short, 120)}${item.reasons.length ? ` reasons=${clip(item.reasons.join("; "), 120)}` : ""}`,
        )
        .join("\n")

      const note = hint
        ? `\n  session_hint=${clip(hint.title, 120)} | ${clip(hint.task, 180)}${hint.recent.length ? `\n  recent=${hint.recent.map((item) => clip(item, 120)).join(" || ")}` : ""}`
        : ""

      return `- ${clip(row.title, 96)}\n  ${meta}\n  command=${clip(row.subtitle, 200)}${note}${kids ? `\n  os_rows:\n${kids}` : ""}`
    })
    .join("\n")

  const strayRows = stray.length
    ? stray
        .slice(0, 20)
        .map(
          (row) =>
            `- pid=${row.pid} ppid=${row.ppid} pgid=${row.pgid} kind=${row.kind} status=${row.status} state=${row.state} cpu=${formatCPU(row.cpu_percent)} rss=${formatMB(row.rss_kb)} elapsed=${row.elapsed} cmd=${clip(row.command_short, 120)}${row.terminal_id ? ` terminal_id=${row.terminal_id}` : ""}${row.process_id ? ` process_id=${row.process_id}` : ""}${row.reasons.length ? ` reasons=${clip(row.reasons.join("; "), 120)}` : ""}`,
        )
        .join("\n")
    : "- none"
  return [
    "Diagnose this local OpenCode/Claxedo process snapshot.",
    "",
    "Group related processes by purpose and decide whether they should stay running, be closed, or be investigated.",
    "Prioritize stale or orphaned workloads first.",
    "Call out where the process appears to come from: managed process, terminal, session, helper, or unrelated system daemon.",
    "Suggest concrete next steps the user can take from the diagnostics screen, but respond as plain markdown.",
    "",
    "Use these sections when relevant:",
    "- Keep Running",
    "- Safe to Close",
    "- Investigate",
    "- Recommended Next Actions",
    "",
    "Heuristics:",
    "- os status=stale means dead CLAXEDO port mapping or missing tracked PTY",
    "- os status=suspect means OS state includes T, Z, or U",
    "- managed process status comes from Claxedo runtime state",
    "- session_hint / recent lines are hints from linked terminal or session history",
    "",
    `Summary: tracked=${rows.length}, os=${input.snapshot.os.length}, listening_ports=${input.snapshot.listening_ports.length}, stale=${stale.length}, suspect=${suspect.length}, total_cpu=${formatCPU(totalCpu)}, total_rss=${formatMB(totalRss)}`,
    "",
    "Tracked resources:",
    tracked || "- none",
    "",
    "Unmapped OS rows:",
    strayRows,
  ].join("\n")
}
