import { execFileSync } from "node:child_process"

export type ProcessRow = { pid: number; parentPid: number; started: string; state?: string }

export function readProcessRow(pid: number): ProcessRow | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Invalid process table pid ${pid}`)
  if (process.platform === "win32") {
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { "$($p.ProcessId) $($p.ParentProcessId) $($p.CreationDate.ToString('o'))" }`
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 30_000 }).trim()
    if (!output) return undefined
    const [found, parent, started] = output.split(/\s+/)
    if (Number(found) !== pid || !Number.isSafeInteger(Number(parent)) || !started) throw new Error(`Unexpected Windows process row: ${output}`)
    return { pid, parentPid: Number(parent), started }
  }
  let output: string
  try {
    output = execFileSync("ps", ["-p", String(pid), "-o", "pid=,ppid=,stat=,lstart="], { encoding: "utf8", timeout: 5_000 }).trim()
  } catch (error) {
    if ((error as { status?: number }).status === 1) return undefined
    throw error
  }
  const [found, parent, state, ...started] = output.split(/\s+/)
  if (Number(found) !== pid || !Number.isSafeInteger(Number(parent)) || !state || !started.length) throw new Error(`Unexpected process row: ${output}`)
  if (state.startsWith("Z")) return undefined
  return { pid, parentPid: Number(parent), state, started: started.join(" ") }
}

export function processAlive(pid: number) {
  return readProcessRow(pid) !== undefined
}
