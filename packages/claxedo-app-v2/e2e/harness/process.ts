import type { ChildProcess } from "node:child_process"

export type OwnedProcess = { child: ChildProcess; log: () => string }

export function captureOutput(child: ChildProcess): OwnedProcess {
  let output = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })
  return { child, log: () => output }
}

export function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)))
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals, processGroup: boolean) {
  if (processGroup && process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  child.kill(signal)
}

export function stopProcess(
  child: ChildProcess | undefined,
  options: { processGroup?: boolean; graceMs?: number } = {},
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve()
  const processGroup = options.processGroup ?? false
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      child.off("exit", onExit)
      child.off("error", onError)
      error ? reject(error) : resolve()
    }
    const onExit = () => finish()
    const onError = (error: Error) => finish(error)
    const timer = setTimeout(() => {
      try {
        signalProcess(child, "SIGKILL", processGroup)
      } catch (error) {
        finish(error as Error)
      }
    }, options.graceMs ?? 8_000)
    child.once("exit", onExit)
    child.once("error", onError)
    try {
      signalProcess(child, "SIGTERM", processGroup)
    } catch (error) {
      finish(error as Error)
    }
  })
}
