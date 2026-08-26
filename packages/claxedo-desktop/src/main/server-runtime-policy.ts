/**
 * The server uses Electron's executable in Node mode, so its V8 policy travels
 * as ordinary Node flags instead of Chromium's utility-process switch.
 *
 * Keep the old generation large enough for provider SDKs and long sessions.
 * V8 derives its young-generation limit from this bound, so an explicit
 * semi-space value could increase memory on constrained machines.
 */
export function claxedoServerExecArgv() {
  return ["--expose-gc", "--optimize-for-size", "--max-old-space-size=512"]
}
