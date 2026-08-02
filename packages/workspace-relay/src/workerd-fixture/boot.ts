import { Miniflare, type MiniflareOptions } from "miniflare"

/**
 * Booting a real workerd, bounded, for the tests in this package that need one.
 *
 * WHY THIS EXISTS. Miniflare spawns workerd as a child process and then awaits
 * a port announcement on a control pipe. That await has no deadline: if the
 * runtime never comes up — the process failed to spawn, or bound no socket and
 * emitted no listen event — `waitForPorts` waits forever. On a laptop that never
 * happens (measured boots here are ~85ms). On a shared GitHub runner it happens
 * often enough to have made `relay-bench-gate` fail six of its eight runs, and
 * the report was always the same shape and never the same test: whichever of the
 * ~10 sequential boots lost the race sat at the deadline until bun killed it,
 * printing `this test timed out after 180000ms` for a runtime that had died
 * before the assertions could run.
 *
 * Nothing about that says anything about the relay, and it does not deserve a
 * red gate. It also must not be papered over by raising the per-test timeout:
 * that only makes the failure slower.
 *
 * WHAT THIS DOES. Bounds the boot at a deadline far above any healthy boot, and
 * retries a boot that misses it on a fresh instance. A workerd that will not
 * start is transient; a fixture that reports the wrong thing is not, so the
 * assertions themselves are untouched and a report that comes back is the
 * report the test judges. Exhausting the retries still fails, loudly, naming
 * the boot as the thing that failed rather than the test body.
 */

/**
 * ~235x the measured healthy boot (~85ms here), so a merely slow runner still
 * boots inside it. The ceiling is what keeps this from reproducing the symptom:
 * the widest caller boots three runtimes inside one 240s test, so the whole
 * budget (tries x deadline = 60s per boot, 180s for that test) has to fit under
 * it. A boot failure must surface as a boot failure, never as a test timeout.
 */
const BOOT_DEADLINE_MS = 20_000
const BOOT_TRIES = 3

class WorkerdBootTimeout extends Error {
  constructor(deadlineMs: number) {
    super(`workerd did not report its ports within ${deadlineMs}ms`)
    this.name = "WorkerdBootTimeout"
  }
}

/**
 * Boot workerd, run `use` against it, and dispose — retrying only a boot that
 * never produced a ready runtime. Once `use` starts, its result and its errors
 * are the test's, retried by nothing.
 */
export async function withWorkerd<T>(options: MiniflareOptions, use: (mf: Miniflare) => Promise<T>): Promise<T> {
  let lastBootError: unknown
  for (let boot = 1; boot <= BOOT_TRIES; boot++) {
    const mf = new Miniflare(options)
    try {
      await Promise.race([
        mf.ready,
        new Promise((_, reject) => setTimeout(() => reject(new WorkerdBootTimeout(BOOT_DEADLINE_MS)), BOOT_DEADLINE_MS)),
      ])
    } catch (error) {
      lastBootError = error
      // A runtime that never came up may not tear down cleanly either, and a
      // disposal that hangs here would reproduce exactly the symptom being
      // fixed. Bound it, and let the process reaper take whatever is left.
      await Promise.race([mf.dispose().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5_000))])
      continue
    }
    try {
      return await use(mf)
    } finally {
      await mf.dispose()
    }
  }
  throw new Error(
    `workerd failed to start ${BOOT_TRIES} times: ${lastBootError instanceof Error ? lastBootError.message : String(lastBootError)}`,
  )
}
