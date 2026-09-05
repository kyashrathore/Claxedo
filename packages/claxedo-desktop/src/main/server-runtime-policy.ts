/**
 * The server uses Electron's executable in Node mode, so its V8 policy travels
 * as ordinary Node flags instead of Chromium's utility-process switch.
 *
 * Keep the old generation large enough for provider SDKs and long sessions.
 * V8 derives its young-generation limit from this bound, so an explicit
 * semi-space value could increase memory on constrained machines.
 */
export function claxedoServerExecArgv() {
  const flags = ["--expose-gc", "--optimize-for-size", "--max-old-space-size=512"]
  // Diagnostic only: with `CLAXEDO_SERVER_V8_PROF_DIR` set, the server child
  // records a V8 CPU profile into that directory. The profile is written when
  // the child exits through its graceful stop (SIGTERM → `claxedo-server-entry`),
  // not when it is killed. Extra V8 flags change the compile-cache flag hash, so
  // a profiled child also pays the uncached import cost.
  const profileDir = process.env.CLAXEDO_SERVER_V8_PROF_DIR?.trim()
  if (profileDir) flags.push("--cpu-prof", `--cpu-prof-dir=${profileDir}`, "--cpu-prof-interval=500")
  return flags
}
