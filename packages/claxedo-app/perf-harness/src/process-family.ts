export type ProcessRow = { pid: number; parentPid: number; startTimeMs: number; command: string }

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})\s+(.+)$/u

export function parseProcessTable(output: string): ProcessRow[] {
  return output.split("\n").flatMap((line) => {
    const match = PS_ROW.exec(line)
    if (!match) return []
    const startTimeMs = Date.parse(match[3])
    return Number.isFinite(startTimeMs) ? [{ pid: Number(match[1]), parentPid: Number(match[2]), startTimeMs, command: match[4] }] : []
  })
}

export async function readProcessTable(): Promise<ProcessRow[]> {
  const child = Bun.spawn({ cmd: ["ps", "-axo", "pid=,ppid=,lstart=,command="], env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`ps failed: ${stderr.trim()}`)
  const rows = parseProcessTable(stdout)
  if (rows.length === 0) throw new Error("ps returned no parseable process rows")
  return rows
}

export function identityKey(row: Pick<ProcessRow, "pid" | "startTimeMs">) {
  return `${String(row.pid)}:${String(row.startTimeMs)}`
}

export class ProcessFamily {
  readonly known = new Map<string, ProcessRow>()

  constructor(readonly root: ProcessRow) {
    this.known.set(identityKey(root), root)
  }

  observe(table: ProcessRow[]) {
    const live = new Set(table.filter((row) => this.known.has(identityKey(row))).map((row) => row.pid))
    let grew = true
    while (grew) {
      grew = false
      for (const row of table) {
        if (this.known.has(identityKey(row)) || !live.has(row.parentPid)) continue
        this.known.set(identityKey(row), row)
        live.add(row.pid)
        grew = true
      }
    }
  }

  alive(table: ProcessRow[]) {
    return table.filter((row) => this.known.has(identityKey(row)))
  }
}
