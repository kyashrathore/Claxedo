import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { loopHold } from "@claxedo/helpers/process"

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

type Pending = {
  pid: number
  bounded: boolean
  settled: boolean
  resolve(row: WindowsProcessRow | undefined): void
  reject(error: Error): void
}

/**
 * Reads the Windows process table through one long-lived PowerShell.
 *
 * A PowerShell started for one read cost 300-450 ms on a 4-vCPU box, and a
 * retirement reads the table three times or more; an interpreter that is
 * already running answers in 10-18 ms. Requests are answered in the order they
 * were sent. A reader that exits is replaced on the next read.
 *
 * `timeoutMs` bounds one read. A read past it is rejected, and the reader is
 * discarded unless an unbounded read is waiting on it: that caller's own
 * deadline ends the process doing the read, and killing the interpreter would
 * turn a slow machine into a failed read for it too.
 */
export function createWindowsProcessTable(options: WindowsProcessTableOptions) {
  let current: TableProcess | undefined

  return {
    read(pid: number, timeoutMs: number): Promise<WindowsProcessRow | undefined> {
      if (!current || current.lost) current = new TableProcess(options.launch)
      return current.ask(pid, timeoutMs)
    },
    /** Lets the interpreter exit once it has answered everything already asked. */
    release() {
      current?.release()
      current = undefined
    },
  }
}

class TableProcess {
  lost: Error | undefined
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending: Pending[] = []
  private partial = ""
  private diagnostics = ""
  private readonly loop: ReturnType<typeof loopHold>

  constructor(launch: () => ChildProcessWithoutNullStreams) {
    this.child = launch()
    this.loop = loopHold(this.child)
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.diagnostics = `${this.diagnostics}${chunk.toString()}`.slice(-2_000)
    })
    this.child.stdin.on("error", (error) => this.lose(`the process table reader stopped taking requests: ${error.message}`))
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk.toString()))
    this.child.on("error", (error) => this.lose(`the process table reader could not be started: ${error.message}`))
    this.child.on("close", (code, signal) => {
      const diagnostics = this.diagnostics.replaceAll(/\s+/g, " ").trim().slice(0, 300)
      this.lose(diagnostics || `the process table reader exited (code ${String(code)}, signal ${String(signal)})`)
    })
    this.idle()
  }

  ask(pid: number, timeoutMs: number): Promise<WindowsProcessRow | undefined> {
    if (this.lost) return Promise.reject(this.lost)
    const answer = Promise.withResolvers<WindowsProcessRow | undefined>()
    const request: Pending = { pid, bounded: timeoutMs > 0, settled: false, resolve: answer.resolve, reject: answer.reject }
    this.pending.push(request)
    this.hold()
    if (request.bounded) {
      // Referenced: Bun on Windows never fires an unreferenced timer that is
      // the loop's only work, and a wedged reader is exactly that case.
      const timer = setTimeout(() => this.expire(request, timeoutMs), timeoutMs)
      void answer.promise.then(() => clearTimeout(timer), () => clearTimeout(timer))
    }
    this.child.stdin.write(`${pid}\n`)
    return answer.promise
  }

  release() {
    this.child.stdin.end()
  }

  private expire(request: Pending, timeoutMs: number) {
    if (request.settled) return
    const reason = new Error(`the process table did not answer for pid ${request.pid} within ${timeoutMs}ms`)
    if (this.pending.some((other) => !other.bounded && !other.settled)) return this.settle(request, () => request.reject(reason))
    this.lose(reason.message)
    this.child.kill()
  }

  private receive(text: string) {
    this.partial += text
    for (let end = this.partial.indexOf("\n"); end >= 0 && !this.lost; end = this.partial.indexOf("\n")) {
      const line = this.partial.slice(0, end).trim()
      this.partial = this.partial.slice(end + 1)
      const request = this.pending.shift()
      if (!request) return this.discard(`the process table reader answered a read nobody sent: ${line.slice(0, 200)}`)
      this.answer(request, line)
    }
    if (!this.pending.length) this.idle()
  }

  private answer(request: Pending, line: string) {
    if (line === "absent") return this.settle(request, () => request.resolve(undefined))
    if (line.startsWith("error ")) return this.settle(request, () => request.reject(new Error(line.slice("error ".length))))
    const row = /^row (\S+) (\d+)$/.exec(line)
    if (row) return this.settle(request, () => request.resolve({ creationDate: row[1], parentPid: Number(row[2]) }))
    this.pending.unshift(request)
    this.discard(`the process table reader answered in an unexpected form: ${line.slice(0, 200)}`)
  }

  private settle(request: Pending, outcome: () => void) {
    if (request.settled) return
    request.settled = true
    outcome()
  }

  private discard(reason: string) {
    this.lose(reason)
    this.child.kill()
  }

  private lose(reason: string) {
    if (this.lost) return
    this.lost = new Error(reason)
    for (const request of this.pending.splice(0)) this.settle(request, () => request.reject(this.lost!))
    this.idle()
  }

  private hold() {
    this.loop.hold()
  }

  private idle() {
    this.loop.idle()
  }
}
