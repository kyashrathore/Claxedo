/**
 * V8 creates an Electron utility process's isolate before Node consumes its
 * `execArgv`. Heap flags therefore have to travel through Chromium's
 * `--js-flags` switch; Electron's own utility-process suite uses the same path.
 *
 * Keep the old generation large enough for provider SDKs and long sessions.
 * V8 derives its young-generation limit from this bound, so an explicit
 * semi-space value could increase memory on constrained machines.
 */
export function claxedoServerExecArgv() {
  return ["--js-flags=--expose-gc --optimize-for-size --max-old-space-size=512"]
}
