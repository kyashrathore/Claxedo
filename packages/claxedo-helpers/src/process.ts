import type { ChildProcess } from "node:child_process"
import { isRecord } from "./guards"
import { parsePositiveNumber } from "./number"

/**
 * Scans `process.argv` live at call time. Only the FIRST occurrence of the flag
 * wins, the value is returned VERBATIM, and the `--name=value` form is not
 * supported — no caller uses it. For an argv array the caller owns, and for the
 * equals form, use `cliFlagValue` from the package root instead.
 */
export function arg(name: string, fallback: string): string
export function arg(name: string, fallback?: string): string | undefined
export function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) return fallback
  return value
}

/** Returns the TRIMMED value; never falls back to a default. */
export function requiredEnv(env: NodeJS.ProcessEnv, name: string, context?: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required${context ? ` for ${context}` : ""}`)
  return value
}

/**
 * Reads `process.env[name]` at CALL time, not at module load, so a test may set
 * the variable after import. The fallback is returned unchanged — it is not
 * rounded or validated, because callers pass a literal or another accessor's
 * result.
 */
export function envPositiveIntMs(name: string, fallback: number): number {
  const parsed = parsePositiveNumber(process.env[name])
  return parsed === undefined ? fallback : Math.round(parsed)
}

const stopping = new WeakMap<ChildProcess, Promise<void>>()

/**
 * Terminates an already-spawned child and resolves only once it is reaped, with
 * a hard upper bound. It ALWAYS resolves: an `error` event, or a throw from the
 * signal call, settles successfully rather than rejecting, because every caller
 * is in a teardown path.
 *
 * Concurrent calls for the same child share one promise, and both the `exit`
 * and `error` listeners plus both timers are released before settling, so
 * repeated teardown leaks neither a timer nor a listener.
 */
export function stopChild(
  child: ChildProcess | undefined,
  options?: { processGroup?: boolean; graceMs?: number; killWaitMs?: number },
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve()

  const existing = stopping.get(child)
  if (existing) return existing

  const graceMs = options?.graceMs ?? 8_000
  const killWaitMs = options?.killWaitMs ?? 5_000

  const pending = new Promise<void>((resolve) => {
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const settle = (): void => {
      if (graceTimer) clearTimeout(graceTimer)
      if (killTimer) clearTimeout(killTimer)
      child.removeListener("exit", settle)
      child.removeListener("error", settle)
      resolve()
    }

    const signal = (name: NodeJS.Signals): void => {
      try {
        // A negative pid targets the process group, but only a child spawned
        // `detached` leads one; ESRCH means it does not, so fall back to the
        // child itself.
        if (options?.processGroup && process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, name)
            return
          } catch (error) {
            const code = isRecord(error) ? error.code : undefined
            if (code !== "ESRCH") throw error
          }
        }
        child.kill(name)
      } catch {
        settle()
      }
    }

    child.once("exit", settle)
    child.once("error", settle)

    signal("SIGTERM")
    graceTimer = setTimeout(() => {
      signal("SIGKILL")
      // Still wait for the exit event, but bounded, so teardown finishes even
      // if the process handle itself is wedged.
      killTimer = setTimeout(settle, killWaitMs)
    }, graceMs)
  })

  stopping.set(child, pending)
  return pending
}
