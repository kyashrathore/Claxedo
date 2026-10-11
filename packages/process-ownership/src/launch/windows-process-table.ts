import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { createLineHelper, type HelperAnswer } from "./line-helper"

/** What the process table says about one pid: its creation time in UTC, ISO 8601 to 100 ns, and its parent. */
export type WindowsProcessRow = { creationDate: string; parentPid: number }

export type WindowsProcessTableOptions = {
  launch: () => ChildProcessWithoutNullStreams
}

/**
 * The PowerShell program the table reader runs: one pid per input line, one
 * answer per output line, in order, until its input closes. It resolves no
 * cmdlet: resolving one makes PowerShell discover modules across
 * `PSModulePath`, which took 12 to 23 s per start under a minimal environment
 * on GitHub's windows-latest image with Az installed. The creation time is
 * printed in UTC because WMI's converter returns a time with no zone.
 */
export const PROCESS_TABLE_PROGRAM = [
  "$ErrorActionPreference = 'Stop'",
  "while ($null -ne ($line = [Console]::In.ReadLine())) {",
  "  try {",
  "    $rows = @(([wmisearcher]\"SELECT CreationDate, ParentProcessId FROM Win32_Process WHERE ProcessId = $([int]$line)\").Get())",
  "    if ($rows.Count -eq 0) { [Console]::Out.WriteLine('absent') } else {",
  "      $created = [System.Management.ManagementDateTimeConverter]::ToDateTime($rows[0]['CreationDate']).ToUniversalTime()",
  "      [Console]::Out.WriteLine('row ' + $created.ToString('o') + ' ' + $rows[0]['ParentProcessId'])",
  "    }",
  "  } catch { [Console]::Out.WriteLine('error ' + ($_.Exception.Message -replace '\\s+', ' ')) }",
  "  [Console]::Out.Flush()",
  "}",
].join("\n")

/**
 * Reads the Windows process table through one long-lived PowerShell.
 *
 * A PowerShell started for one read cost 300-450 ms on a 4-vCPU box, and a
 * retirement reads the table three times or more; an interpreter that is
 * already running answers in 10-18 ms.
 */
export function createWindowsProcessTable(options: WindowsProcessTableOptions) {
  const helper = createLineHelper({ name: "process table reader", launch: options.launch })
  return {
    read: (pid: number, timeoutMs: number) => helper.ask(String(pid), `pid ${pid}`, timeoutMs, processRow),
    /** Lets the interpreter exit once it has answered everything already asked. */
    release: () => helper.release(),
  }
}

function processRow(line: string): HelperAnswer<WindowsProcessRow | undefined> {
  if (line === "absent") return { value: undefined }
  if (line.startsWith("error ")) return { refusal: line.slice("error ".length) }
  const [, creationDate, parentPid] = /^row (\S+) (\d+)$/.exec(line) ?? []
  return creationDate && parentPid ? { value: { creationDate, parentPid: Number(parentPid) } } : undefined
}
