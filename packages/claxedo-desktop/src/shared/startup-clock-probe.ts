/**
 * Startup clock probe. HARNESS/DIAGNOSTIC ONLY — inert unless asked for.
 *
 * This side only WRITES. Reading the log back and turning it into the lead is
 * the benchmark harness's job and lives there
 * (`@claxedo/perf-harness`, `agent-claxedo-launcher.ts`), so the product never
 * carries a parser it does not use.
 *
 * Cold-boot reasoning kept stalling on one unmeasurable quantity: the LEAD, the
 * distance between the moment the local server can serve a request and the
 * moment the renderer issues the first engine-bound one. Nothing observable
 * spanned it. The renderer's `performance.timeOrigin` is an epoch value and the
 * server child's readiness is an event in a different process, so the two were
 * never on one clock; the desktop's own log line is formatted to whole seconds
 * (`platform/runtime/lib/log.ts`), a least count 1,000x coarser than the
 * question, and the benchmark launcher discards the child's stdio entirely.
 *
 * This writes epoch-millisecond stamps for the handoff from BOTH sides of it —
 * the server child at listen, the main process at each step it performs before
 * publishing the URL — into one append-only JSONL file, so the lead and its
 * decomposition are a subtraction rather than an inference.
 *
 * It is off unless `CLAXEDO_DIAG_STARTUP_CLOCK` names a file. The path is read
 * once at module load, so a production process pays one env read and, per
 * event, one comparison against `undefined`. Nothing here participates in
 * readiness: every write is best-effort and swallowing, and callers place it
 * AFTER the step it stamps so a failing probe cannot reorder or delay startup.
 */
import { appendFileSync } from "node:fs"

export type StartupClockEvent = {
  event: string
  /** Wall clock, the only clock shared by the server child, main, and the renderer's `timeOrigin`. */
  epochMs: number
  pid: number
  /** This process's own start, from `performance.timeOrigin`, on that same clock. */
  processStartEpochMs: number
  detail?: Record<string, number | string | boolean>
}

export function startupClockProbePath(env: NodeJS.ProcessEnv): string | undefined {
  return env.CLAXEDO_DIAG_STARTUP_CLOCK?.trim() || undefined
}

export function startupClockEvent(
  event: string,
  detail?: Record<string, number | string | boolean>,
): StartupClockEvent {
  return {
    event,
    epochMs: Date.now(),
    pid: process.pid,
    processStartEpochMs: Math.round(performance.timeOrigin),
    ...(detail ? { detail } : {}),
  }
}

const target = startupClockProbePath(process.env)

export function recordStartupClock(event: string, detail?: Record<string, number | string | boolean>) {
  if (!target) return
  try {
    appendFileSync(target, `${JSON.stringify(startupClockEvent(event, detail))}\n`)
  } catch {}
}
