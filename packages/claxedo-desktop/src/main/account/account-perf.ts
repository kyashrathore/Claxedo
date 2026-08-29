/**
 * Diagnostics-only AccountPort timing marks.
 *
 * Off by default. Arm with `CLAXEDO_ACCOUNT_PERF=1`. Optional
 * `CLAXEDO_ACCOUNT_PERF_PATH` writes NDJSON; otherwise lines go to stderr.
 *
 * Not a product log channel — marks exist so load ladders can isolate IPC tax
 * without polluting normal desktop diagnostics.
 */

import { appendFileSync } from "node:fs"

export type AccountPerfMark = {
  t: number
  mark: string
} & Record<string, unknown>

let sinkPath: string | undefined
let enabledCache: boolean | undefined

export function accountPerfEnabled(): boolean {
  if (enabledCache === undefined) {
    enabledCache = process.env.CLAXEDO_ACCOUNT_PERF === "1"
    sinkPath = process.env.CLAXEDO_ACCOUNT_PERF_PATH
  }
  return enabledCache
}

/** Test/bench seam: force enable without env (clears on process restart). */
export function accountPerfForce(enabled: boolean, path?: string) {
  enabledCache = enabled
  sinkPath = path
}

export function accountPerfMark(mark: string, fields: Record<string, unknown> = {}) {
  if (!accountPerfEnabled()) return
  const line: AccountPerfMark = {
    t: performance.now(),
    mark,
    ...fields,
  }
  const text = `${JSON.stringify(line)}\n`
  if (sinkPath) {
    try {
      appendFileSync(sinkPath, text)
      return
    } catch {
      // fall through to stderr
    }
  }
  process.stderr.write(text)
}

export function accountPerfNow() {
  return performance.now()
}
