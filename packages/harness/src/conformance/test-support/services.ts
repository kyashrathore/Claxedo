import { execFileSync, spawn as nodeSpawn } from "node:child_process"
import { launchOwnedProcess, retirementSettled, volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import type { HarnessServices, OwnedProcess, SpawnCommand, SpawnOptions } from "../../contract"
import { pollUntil } from "./poll"
import { singleFlightUntil } from "@claxedo/helpers"

export type TestServices = HarnessServices & {
  processes: OwnedProcess[]
  entries: { level: string; message: string }[]
  healthChanges: { count: number }
}

function groupHasLiveMember(pgid: number): boolean {
  const rows = execFileSync("/bin/ps", ["-A", "-o", "pgid=", "-o", "stat="], { encoding: "utf8" })
  return rows.split("\n").some((row) => {
    const match = /^\s*(\d+)\s+(\S+)/.exec(row)
    return match?.[1] === String(pgid) && !match[2]?.startsWith("Z")
  })
}

function groupProcess(command: SpawnCommand): OwnedProcess {
  const child = nodeSpawn(command.file, [...command.args], { cwd: command.cwd, env: command.env, stdio: ["pipe", "pipe", "pipe"], detached: true })
  if (!child.pid || !child.stdin || !child.stdout || !child.stderr) throw new Error("Test child process did not start")
  const pid = child.pid
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  return {
    pid, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited,
    retire: singleFlightUntil(async (deadline: Parameters<OwnedProcess["retire"]>[0]) => {
      const stop = (signal: NodeJS.Signals) => process.kill(-pid, signal)
      const alive = () => {
        try {
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
      await pollUntil(() => alive() ? undefined : true, deadline.at, deadline.signal)
      if (alive()) return { stopped: false, error: { code: "deadline", message: "Process group stayed alive" } }
      await exited
      return { stopped: true }
    }, (result) => result.stopped),
  }
}

const ownership = volatileLaunchOwnership()

async function gatedProcess(command: SpawnCommand): Promise<OwnedProcess> {
  const launch = await launchOwnedProcess({ ownership, role: "harness", payload: { command: command.file, args: [...command.args] },
    cwd: command.cwd, env: command.env })
  const { child } = launch
  if (!child.stdin || !child.stdout || !child.stderr || launch.payloadPid === undefined) {
    await launch.retire({ termGraceMs: 1_000, killVerifyMs: 1_000 })
    throw new Error(`Test launch ${launch.launchId} has no payload process or standard streams`)
  }
  const exited: OwnedProcess["exited"] = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise((resolve) => { child.once("exit", (code, signal) => resolve({ code, signal })) })
  return {
    pid: launch.payloadPid, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited,
    retire: singleFlightUntil(async (deadline: Parameters<OwnedProcess["retire"]>[0]): Promise<Awaited<ReturnType<OwnedProcess["retire"]>>> => {
      const remainingMs = Math.max(2, deadline.at - Date.now())
      const termGraceMs = Math.floor(remainingMs / 2)
      const result = await launch.retire({ termGraceMs, killVerifyMs: remainingMs - termGraceMs })
      if (retirementSettled(result)) return { stopped: true }
      return { stopped: false, error: result.error ?? { code: "retirement_unverified", message: `Test launch ${launch.launchId} retirement was not verified` } }
    }, (result) => result.stopped),
  }
}

async function ownedProcess(command: SpawnCommand, options: SpawnOptions): Promise<OwnedProcess> {
  if (options.signal.aborted) throw new Error(`Spawn of ${options.label} was aborted before it started`)
  return process.platform === "win32" ? gatedProcess(command) : groupProcess(command)
}

export function createTestServices(): TestServices {
  const processes: OwnedProcess[] = []
  const entries: { level: string; message: string }[] = []
  const healthChanges = { count: 0 }
  const record = (level: string, message: string) => entries.push({ level, message })
  return {
    processes, entries, healthChanges,
    spawn: async (command, options) => {
      const process = await ownedProcess(command, options)
      processes.push(process)
      return process
    },
    recordHomeUse: async () => {},
    firstPartyMcp: () => undefined,
    healthChanged: () => { healthChanges.count += 1 },
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
