import { execFileSync } from "node:child_process"

export type ProcessInventoryRow = {
  pid: number
  ppid: number
  command: string
}

const WINDOWS_PROCESS_INVENTORY = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$rows = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CommandLine",
  "ConvertTo-Json -Compress -InputObject @($rows | Select-Object ProcessId,ParentProcessId,CommandLine)",
].join("; ")

/**
 * Read the operating system's authoritative process inventory. Windows uses
 * the same Win32_Process CIM source as desktop diagnostics; supported POSIX
 * hosts use the portable ps fields the test used before Windows qualification.
 */
export function readProcessInventory(platform: NodeJS.Platform = process.platform): ProcessInventoryRow[] {
  if (platform === "win32") {
    const output = execFileSync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_PROCESS_INVENTORY,
    ], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    return parseWindowsProcessInventory(output)
  }

  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  return parsePosixProcessInventory(output)
}

export function parsePosixProcessInventory(output: string): ProcessInventoryRow[] {
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!.trim() }] : []
  })
}

export function parseWindowsProcessInventory(output: string): ProcessInventoryRow[] {
  const decoded = JSON.parse(output.replace(/^\uFEFF/, "")) as WindowsProcessRow | WindowsProcessRow[]
  const rows = Array.isArray(decoded) ? decoded : [decoded]
  return rows.map((row) => {
    if (
      !Number.isInteger(row.ProcessId) || row.ProcessId <= 0 ||
      !Number.isInteger(row.ParentProcessId) || row.ParentProcessId < 0
    ) {
      throw new Error("Win32_Process returned an invalid process identity")
    }
    return {
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      command: typeof row.CommandLine === "string" ? row.CommandLine.trim() : "",
    }
  })
}

export function descendantCommands(rootPid: number, rows = readProcessInventory()) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) throw new Error(`invalid process root ${String(rootPid)}`)
  if (!rows.some((row) => row.pid === rootPid)) {
    throw new Error(`process inventory did not contain root ${String(rootPid)}`)
  }

  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (!descendants.has(row.ppid) || descendants.has(row.pid)) continue
      descendants.add(row.pid)
      changed = true
    }
  }

  return rows.filter((row) => descendants.has(row.pid)).map((row) => {
    if (!row.command) throw new Error(`process ${String(row.pid)} had no observable command line`)
    return row.command
  })
}

type WindowsProcessRow = {
  ProcessId: number
  ParentProcessId: number
  CommandLine: string | null
}
