import type { ChildProcess } from "node:child_process"

/**
 * Poll `url` until it answers 2xx, else throw a GATING error carrying the log
 * tail. A `child` that exits before answering fails fast with its exit code.
 * Shared by every Tier R/live spec that boots a real server, so the deadline,
 * cadence and failure text are one contract rather than a drifting copy each.
 */
export async function waitForHealth(url: string, options: {
  label: string
  log: () => string
  child?: ChildProcess
  timeoutMs?: number
  intervalMs?: number
  requestTimeoutMs?: number
  tailLines?: number
}) {
  const timeoutMs = options.timeoutMs ?? 90_000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (options.child && options.child.exitCode !== null) {
      throw new Error(`GATING: ${options.label} exited ${options.child.exitCode}\n${options.log()}`)
    }
    const ok = await fetch(url, options.requestTimeoutMs ? { signal: AbortSignal.timeout(options.requestTimeoutMs) } : undefined)
      .then((response) => response.ok)
      .catch(() => false)
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 250))
  }
  const tail = options.log().split("\n").slice(-(options.tailLines ?? 80)).join("\n")
  throw new Error(`GATING: ${options.label} did not become healthy at ${url} within ${timeoutMs}ms. Log tail:\n${tail}`)
}
