// Preloaded into every wrapped `bun test` run (see test-deadline.mjs).
//
// bun 1.3.14 on win32 parks its event loop permanently once the only pending
// wake-ups are unref'd timers. The CI unit lane hit that three independent
// ways: a test awaiting a race whose sole resolver was an unref'd timeout
// (desktop electron-seams, run 374), and two suites that deterministically
// stalled loading their NEXT test file right after a file that leaves only
// unref'd timers behind (sandbox-manager after cloudflare.test.ts, whose
// driver calls schedule AbortSignal.timeout timers; claxedo-connections after
// device-routes.test.ts, whose attempt stores keep unref'd 30s sweep
// intervals — run 375, both attempts, same boundary each time). Loading the
// next module needs an event-loop tick, and the parked loop never delivers
// it — these were the only three packages that had never completed on
// Windows.
//
// One ref'd interval keeps the loop scheduling, so unref'd timers keep firing
// and file transitions keep ticking. `bun test` force-exits after the run, so
// a live ref'd interval never blocks exit (probed on 1.3.14). POSIX loops do
// not park this way; gate to win32 so proven-green lanes run byte-identical.
if (process.platform === "win32") {
  setInterval(() => {}, 250)
}
