import { execFileSync } from "node:child_process"
import { SCRIPTED_ACP_AGENT_ENTRY } from "../../../../harness/e2e/harness/acp/connection"

type ProcessRow = { readonly pid: number; readonly ppid: number; readonly command: string }

function processTable(): ProcessRow[] {
  return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : []
    })
}

function listenerPid(port: number): number {
  const pid = Number(execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n")[0])
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`no process listens on ${port}`)
  return pid
}

export function scriptedAgentPids(daemonPort: number): number[] {
  const daemon = listenerPid(daemonPort)
  const table = processTable()
  const parentOf = new Map(table.map((row) => [row.pid, row.ppid]))
  const underDaemon = (pid: number) => {
    for (let parent = parentOf.get(pid); parent !== undefined && parent > 1; parent = parentOf.get(parent)) if (parent === daemon) return true
    return false
  }
  return table.filter((row) => row.command.includes(SCRIPTED_ACP_AGENT_ENTRY) && underDaemon(row.pid)).map((row) => row.pid)
}
