import type { ForkOptions } from "node:child_process"

import { claxedoServerExecArgv } from "./server-runtime-policy"

export function claxedoServerForkOptions(env: Record<string, string>): ForkOptions {
  return {
    execPath: process.execPath,
    execArgv: claxedoServerExecArgv(),
    detached: true,
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    // Detached ownership includes file descriptors: inherited terminal pipes
    // keep launchers alive even after the daemon is reparented.
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  }
}
