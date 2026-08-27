import { testRender as opentuiTestRender } from "@opentui/solid"

/**
 * Every tui test renders through this wrapper so the native render thread is
 * OFF on every platform. @opentui defaults `useThread` to true everywhere
 * except Linux, and the threaded win32 teardown (`destroyRenderer`'s
 * synchronous FFI thread join) can deadlock under `bun test` — with
 * `--only-failures` that hang is completely silent, and it wedged the whole
 * Windows unit lane (runs 367/368: zero failures, then a 20-35 minute stall
 * to the step timeout). Linux CI has always exercised the non-threaded path,
 * so forcing it changes nothing where this suite is proven green.
 */
export const testRender: typeof opentuiTestRender = (node, renderConfig = {}) =>
  opentuiTestRender(node, { useThread: false, ...renderConfig })
