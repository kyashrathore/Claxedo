import type { ChildProcess } from "node:child_process"

export type HealthOptions = {
  label: string
  log: () => string
  child?: ChildProcess
  ready?: () => boolean
  timeoutMs?: number
  intervalMs?: number
}

async function probe(url: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return response.ok ? { ok: true } : { ok: false, reason: `HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function waitForHealth(url: string, options: HealthOptions) {
  const timeoutMs = options.timeoutMs ?? 90_000
  const deadline = Date.now() + timeoutMs
  let lastReason = "no response yet"
  while (Date.now() < deadline) {
    if (options.child && (options.child.exitCode !== null || options.child.signalCode !== null)) {
      throw new Error(`${options.label} exited with ${options.child.exitCode ?? options.child.signalCode}\n${options.log()}`)
    }
    const result = await probe(url)
    if (result.ok && (options.ready?.() ?? true)) return
    lastReason = result.ok ? `${url} answered, but not from ${options.label}` : result.reason
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 250))
  }
  const tail = options.log().split("\n").slice(-80).join("\n")
  throw new Error(
    `${options.label} did not become healthy at ${url} within ${timeoutMs}ms (last: ${lastReason}). Log tail:\n${tail}`,
  )
}
