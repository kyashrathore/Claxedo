import { execSync } from "node:child_process"
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
 * sequential boots lost the race sat at the deadline until bun killed it,
 * printing `this test timed out after 180000ms` for a runtime that had died
 * before the assertions could run.
 *
 * Nothing about that says anything about the relay, and it does not deserve a
 * red gate. It also must not be papered over by raising the per-test timeout:
 * that only makes the failure slower.
 *
 * WHY ONE BOOT PER TEST FILE AND NO MID-RUN DISPOSE — LOAD-BEARING, DO NOT
 * REGRESS. Under bun 1.3.14 on Linux, `Miniflare#dispose()` poisons every
 * later `new Miniflare(...)` in the same process: the disposed child's teardown
 * corrupts bun's fd bookkeeping, and the NEXT workerd spawned gets its
 * control pipe torn out from under it — workerd logs
 * `disconnected: miniposix::write(fd, pos, size): Broken pipe; fd = 3` and
 * miniflare's `waitForPorts` (and so `mf.ready`) hangs until the test timeout.
 * Measured here, deterministically: boot→dispose→boot wedges the second boot
 * every time, even with a multi-second settle between; boot→boot with the
 * first instance still alive works every time. `mf.setOptions()` is equally
 * broken under bun ("this.#runtimeDispatcher?.close is not a function"), so
 * live reconfiguration is no escape hatch either. macOS is unaffected, which
 * is how per-test boots were authored in the first place.
 *
 * The only structure that holds on both platforms is therefore:
 *   - each test file boots exactly ONE Miniflare, in `beforeAll`, hosting every
 *     configuration it needs as separate workers in one `workers: [...]` array
 *     routed by an entry worker; and
 *   - NOBODY calls `dispose()`, ever — with `bun test` running every test file
 *     in one process, any file's teardown would wedge the next file's boot.
 *     Teardown is `reapWorkerd()` instead: SIGKILL the workerd children
 *     directly, which measurably does NOT poison later boots the way
 *     `dispose()` does, and works file-order-independently because each file
 *     only ever kills children whose tests are already finished.
 *
 * (A process-exit hook was tried first and does not work: `bun test` exits
 * without firing `process.on("exit")` handlers, so undisposed workerd children
 * would simply outlive the run — also measured.)
 *
 * WHAT THIS DOES. Bounds the boot at a deadline far above any healthy boot, and
 * retries a boot that misses it on a fresh instance (abandoning the stuck one
 * to the next `reapWorkerd()` — disposing it would poison the retry). A workerd
 * that will not start is transient; a fixture that reports the wrong thing is
 * not, so the assertions themselves are untouched and a report that comes back
 * is the report the test judges. Exhausting the retries still fails, loudly,
 * naming the boot as the thing that failed rather than the test body.
 */

/**
 * ~235x the measured healthy boot (~85ms here), so a merely slow runner still
 * boots inside it. The whole retry budget (tries x deadline = 60s) has to fit
 * under the `beforeAll` timeout of every caller. A boot failure must surface
 * as a boot failure, never as a test timeout.
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
 * Kill this process's workerd children outright. The `afterAll` replacement
 * for `Miniflare#dispose()`, which must never be called (see header). Only
 * direct children of this process whose command line names workerd can match,
 * so nothing outside this test process is touched — and because `bun test`
 * runs files sequentially, the only children alive when a file's `afterAll`
 * runs are ones whose tests have already finished.
 */
export function reapWorkerd() {
  try {
    execSync(`pkill -9 -P ${process.pid} -f workerd`, { stdio: "ignore" })
  } catch {
    // pkill exits non-zero when nothing matched; there is nothing to do.
  }
}

/**
 * Boot workerd once and return the ready Miniflare. Call it exactly once per
 * test file, from `beforeAll`, with a `workers` array hosting every
 * configuration the file tests. Do NOT dispose the result — not in `afterAll`,
 * not anywhere: disposal wedges every later boot in the process (see header).
 * Tear down with `reapWorkerd()` in `afterAll` instead.
 */
export async function bootWorkerd(options: MiniflareOptions): Promise<Miniflare> {
  let lastBootError: unknown
  for (let boot = 1; boot <= BOOT_TRIES; boot++) {
    const mf = new Miniflare(options)
    try {
      await Promise.race([
        mf.ready,
        new Promise((_, reject) => setTimeout(() => reject(new WorkerdBootTimeout(BOOT_DEADLINE_MS)), BOOT_DEADLINE_MS)),
      ])
      return mf
    } catch (error) {
      lastBootError = error
      // Deliberately NOT disposed: dispose is the very call that wedges the
      // next boot. The abandoned instance idles until the next reapWorkerd().
    }
  }
  throw new Error(
    `workerd failed to start ${BOOT_TRIES} times: ${lastBootError instanceof Error ? lastBootError.message : String(lastBootError)}`,
  )
}
