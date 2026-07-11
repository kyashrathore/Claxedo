import { Process } from "@claxedo/process/process"
import { collapse, clip } from "../../utils/text"

// Pure aggregation, scoring, and labelling logic for the Process Diagnostics
// dialog. This is the code that decides how OS rows roll up into groups and in
// what order rows/groups are surfaced — which in turn drives which rows a user
// SIGKILLs via the bulk "kill stale"/"kill leaks" actions. It is deliberately
// dependency-free (only the wire schema + string helpers) so it can be tested
// exhaustively without mounting the dialog.

type OsRow = Process.DiagnosticOsProcess

/** Sort weight for an OS-row status ladder: stale worst, then suspect, running, idle. */
export const score = (status: string) =>
  status === "stale" ? 3 : status === "suspect" ? 2 : status === "running" ? 1 : 0

/** Sort weight for a group status ladder (groups are never "idle"). */
export const groupScore = (status: Process.DiagnosticStatus) =>
  status === "stale" ? 3 : status === "suspect" ? 2 : 1

/** Collapse whitespace and clip to `max`, tolerating undefined. */
export const clipped = (value: string | undefined, max = 180) => clip(collapse(value), max)

export const EMPTY_BUCKET: Process.DiagnosticSummaryBucket = {
  groups: 0,
  rows: 0,
  cpu_percent: 0,
  rss_kb: 0,
  hidden_children: 0,
  problem_children: 0,
}

/**
 * Resolve a child directory against a workspace root. Absolute `dir` wins
 * outright; a relative `dir` is joined to `root` with slash separators after
 * trimming trailing root separators and leading `./`/`../`-ish noise.
 */
export const rooted = (root?: string, dir?: string) => {
  if (!dir) return root
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(dir)) return dir
  if (!root) return dir
  return `${root.replace(/[\\/]+$/, "")}/${dir.replace(/^[./\\]+/, "")}`
}

/** ps etime format (MM:SS, HH:MM:SS, DD-HH:MM:SS) → human-readable coarse age. */
export function formatAge(elapsed: string) {
  const dayMatch = elapsed.match(/^(\d+)-(\d+):(\d+):(\d+)$/)
  if (dayMatch) {
    const d = Number(dayMatch[1])
    const h = Number(dayMatch[2])
    return h > 0 ? `${d}d ${h}h` : `${d}d`
  }
  const hmsMatch = elapsed.match(/^(\d+):(\d+):(\d+)$/)
  if (hmsMatch) {
    const h = Number(hmsMatch[1])
    const m = Number(hmsMatch[2])
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  const msMatch = elapsed.match(/^(\d+):(\d+)$/)
  if (msMatch) {
    const m = Number(msMatch[1])
    const s = Number(msMatch[2])
    return m > 0 ? `${m}m ${s}s` : `${s}s`
  }
  return elapsed
}

/** Seconds of uptime → coarse "Nd Nh" / "Nh Nm" / "Nm" label. */
export function formatUptimeSeconds(s: number) {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

/** Map an OS-detected reason code to a user-facing sentence. */
export function reasonLabel(value: string) {
  if (value === "missing-pty") return "Orphaned terminal"
  if (value === "dead-port") return "Port not listening"
  if (value === "bad-state") return "Unhealthy state"
  if (value === "long-running") return "Running 7+ days"
  return value
}

/** Short badge label for an owner kind. */
export function kindLabel(value: Process.DiagnosticOwnerKind) {
  if (value === "managed_process") return "Managed"
  if (value === "mcp_server") return "MCP"
  if (value === "leaked_server") return "Stale"
  if (value === "external") return "Other"
  if (value === "server") return "Server"
  if (value === "app") return "App"
  return "Tab"
}

/** Tailwind tone classes for an owner-kind badge. */
export function kindTone(value: Process.DiagnosticOwnerKind) {
  if (value === "mcp_server") return "bg-surface-info-base/10 text-text-on-info-base"
  if (value === "leaked_server") return "bg-surface-critical-base/10 text-text-on-critical-base"
  if (value === "external") return "bg-surface-warning-base/10 text-text-on-warning-base"
  if (value === "server" || value === "app") return "bg-surface-base-hover text-text-weak"
  return "bg-surface-info-base/10 text-text-on-info-base"
}

/**
 * Roll a set of child rows up to a single group status. A single stale child
 * poisons the whole group to stale; a single suspect makes it suspect; else
 * active. This is what escalates a group into the "kill" candidate buckets.
 */
export function groupStatus(rows: OsRow[]): Process.DiagnosticStatus {
  return rows.some((row) => row.status === "stale")
    ? "stale"
    : rows.some((row) => row.status === "suspect")
      ? "suspect"
      : "active"
}

/** Human title for an external server group: prefer its listening port. */
export function externalTitle(row: OsRow) {
  if (row.port != null) return `Server on :${row.port}`
  return `Server ${row.pid}`
}

/**
 * Aggregate raw OS rows into external-server groups keyed by `owner_key`.
 * Rows that are not `external` or have no `owner_key` are ignored. Within a
 * group children are depth-then-resource sorted; the representative row (for
 * title/pid) is the heaviest by rss→cpu→pid. Ports are de-duplicated and
 * ascending. Groups are returned worst-status-first, then heaviest-first.
 */
export function buildExternal(rows: OsRow[]): Process.DiagnosticGroup[] {
  const by = new Map<string, OsRow[]>()
  for (const row of rows) {
    if (row.owner_kind !== "external" || !row.owner_key) continue
    if (!by.has(row.owner_key)) by.set(row.owner_key, [])
    by.get(row.owner_key)!.push(row)
  }

  return [...by.entries()]
    .map(([key, list]) => {
      const children = [...list].sort(
        (a, b) => a.depth - b.depth || b.rss_kb - a.rss_kb || b.cpu_percent - a.cpu_percent || a.pid - b.pid,
      )
      const row = [...children].sort((a, b) => b.rss_kb - a.rss_kb || b.cpu_percent - a.cpu_percent || a.pid - b.pid)[0]
      const ports = [...new Set(children.flatMap((item) => (item.port != null ? [item.port] : [])))].sort(
        (a, b) => a - b,
      )
      return Process.DiagnosticGroup.parse({
        key,
        kind: "external",
        title: externalTitle(row),
        status: groupStatus(children),
        cpu_percent: children.reduce((sum, item) => sum + item.cpu_percent, 0),
        rss_kb: children.reduce((sum, item) => sum + item.rss_kb, 0),
        ports,
        pid: row.pid,
        terminal_id: row.terminal_id,
        process_id: row.process_id,
        tab_id: row.tab_id,
        current: false,
        leaked: false,
        hidden_children: children.filter((item) => item.hidden_by_default).length,
        problem_children: children.filter((item) => item.depth > 0 && !item.hidden_by_default).length,
        children,
      })
    })
    .sort((a, b) => groupScore(b.status) - groupScore(a.status) || b.rss_kb - a.rss_kb || b.cpu_percent - a.cpu_percent)
}
