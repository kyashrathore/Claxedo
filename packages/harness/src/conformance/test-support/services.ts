import { execFileSync, spawn as nodeSpawn } from "node:child_process"
import type { HarnessServices, OwnedProcess, SpawnCommand, SpawnOptions } from "../../contract"

export type TestServices = HarnessServices & {
  processes: OwnedProcess[]
  entries: { level: string; message: string }[]
  transcriptRows: Map<string, unknown[]>
}

function groupHasLiveMember(pgid: number): boolean {
  const rows = execFileSync("/bin/ps", ["-A", "-o", "pgid=", "-o", "stat="], { encoding: "utf8" })
  return rows.split("\n").some((row) => {
    const match = /^\s*(\d+)\s+(\S+)/.exec(row)
    return match?.[1] === String(pgid) && !match[2]?.startsWith("Z")
  })
}

function childProcess(command: SpawnCommand, _options: SpawnOptions): OwnedProcess {
  const child = nodeSpawn(command.file, [...command.args], {
    cwd: command.cwd, env: command.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
  })
  if (!child.pid || !child.stdin || !child.stdout || !child.stderr) throw new Error("Test child process did not start")
  const pid = child.pid
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  return {
    pid, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited,
    async retire(deadline) {
      const stop = (signal: NodeJS.Signals) => {
        if (process.platform === "win32") child.kill(signal)
        else process.kill(-pid, signal)
      }
      const alive = () => {
        try {
          if (process.platform === "win32") return child.exitCode === null && child.signalCode === null
          process.kill(-pid, 0)
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
          if ((error as NodeJS.ErrnoException).code === "EPERM") return groupHasLiveMember(pid)
          throw error
        }
      }
      try { stop("SIGTERM") }
      catch (error) { if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline.at - Date.now()))))])
      if (alive()) {
        try { stop("SIGKILL") }
        catch (error) { if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error }
      }
      while (alive() && Date.now() < deadline.at && !deadline.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      if (alive()) return { stopped: false, error: { code: "deadline", message: "Process group stayed alive" } }
      await exited
      return { stopped: true }
    },
  }
}

export function createTestServices(): TestServices {
  const processes: OwnedProcess[] = []
  const entries: { level: string; message: string }[] = []
  const transcriptRows = new Map<string, unknown[]>()
  const record = (level: string, message: string) => entries.push({ level, message })
  return {
    processes, entries, transcriptRows,
    spawn: async (command, options) => {
      const process = childProcess(command, options)
      processes.push(process)
      return process
    },
    firstPartyMcp: () => undefined,
    transcripts: {
      register: async ({ filePath }) => { transcriptRows.set(filePath, []); return { state: "ready", handle: filePath } },
      open: async ({ handle }) => {
        const messages = transcriptRows.get(handle)
        return messages ? { state: "ready", messages } : { state: "unavailable", reason: "Unknown transcript" }
      },
    },
    patternEvaluator: async (checks, signal) => {
      for (const check of checks) {
        if (signal?.aborted) throw new Error("Pattern validation cancelled")
        const pattern = new RegExp(check.pattern)
        if (check.value !== undefined && !pattern.test(check.value)) throw new Error(`Pattern mismatch: ${check.field}`)
      }
    },
    log: {
      debug: (message) => record("debug", message), info: (message) => record("info", message),
      warn: (message) => record("warn", message), error: (message) => record("error", message),
    },
    clock: { now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
  }
}
