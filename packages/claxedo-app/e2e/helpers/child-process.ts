import type { ChildProcess } from "node:child_process"

const stops = new WeakMap<ChildProcess, Promise<void>>()

/** Resolve only after the child exits, escalating an unresponsive child to SIGKILL. */
export function stopChild(child: ChildProcess | undefined, options: { processGroup?: boolean; graceMs?: number } = {}) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve()
  const pending = stops.get(child)
  if (pending) return pending
  const signal = (value: NodeJS.Signals) => {
    if (options.processGroup && process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, value)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
    child.kill(value)
  }
  const stopping = new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      child.off("exit", onExit)
      child.off("error", onError)
      error ? reject(error) : resolve()
    }
    const onExit = () => finish()
    const onError = (error: Error) => finish(error)
    const timer = setTimeout(() => {
      try { signal("SIGKILL") } catch (error) { finish(error as Error) }
    }, options.graceMs ?? 8_000)
    child.once("exit", onExit)
    child.once("error", onError)
    try { signal("SIGTERM") } catch (error) { finish(error as Error) }
  })
  stops.set(child, stopping)
  return stopping
}
