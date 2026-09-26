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

export function stopProcess(
  child: ChildProcess | undefined,
  options: { graceMs?: number } = {},
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve()
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
        child.kill("SIGKILL")
      } catch (error) {
        finish(error as Error)
      }
    }, options.graceMs ?? 8_000)
    child.once("exit", onExit)
    child.once("error", onError)
    try {
      child.kill("SIGTERM")
    } catch (error) {
      finish(error as Error)
    }
  })
}
