import type { ChildProcess } from "node:child_process"

const READY_TYPE = "claxedo-server-ready"

/**
 * Wait for readiness from the server process itself, not from whichever process
 * happens to answer on the requested port. The same IPC contract gates Electron
 * main, and the bundled server emits it only after its own listener is bound.
 */
export function waitForClaxedoServerReady(
  child: ChildProcess,
  expectedPort: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => finish(new Error("Claxedo web server did not publish readiness")), timeoutMs)
    timeout.unref()

    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("error", onError)
      child.off("exit", onExit)
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onMessage = (input: unknown) => {
      const port = readyPort(input)
      if (port === undefined) return
      if (port !== expectedPort) {
        finish(new Error(`Claxedo web server reported unexpected port ${String(port)}`))
        return
      }
      finish()
    }
    const onError = (error: Error) =>
      finish(new Error(`Claxedo web server failed before readiness: ${error.message}`, { cause: error }))
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Claxedo web server exited before readiness (code=${String(code)}, signal=${String(signal)})`))
    }

    child.on("message", onMessage)
    child.once("error", onError)
    child.once("exit", onExit)
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode)
  })
}

function readyPort(input: unknown): number | undefined {
  if (typeof input !== "object" || input === null) return
  const record = input as Record<string, unknown>
  if (record.type !== READY_TYPE || typeof record.port !== "number" || !Number.isInteger(record.port)) return
  return record.port
}
