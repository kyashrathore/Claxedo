import type { ForkOptions } from "node:child_process"

import { claxedoServerExecArgv } from "./server-runtime-policy"

export function claxedoServerForkOptions(env: Record<string, string>): ForkOptions {
  return {
    execPath: process.execPath,
    execArgv: claxedoServerExecArgv(),
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  }
}
