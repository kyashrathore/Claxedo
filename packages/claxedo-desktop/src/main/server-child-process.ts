import type { ForkOptions } from "node:child_process"

import { claxedoServerExecArgv } from "./server-runtime-policy"

/**
 * `logFd` is an open file descriptor the daemon's stdout and stderr are written
 * to. A file, unlike an inherited terminal pipe, holds no launcher open once
 * the detached daemon is reparented, so it is the only stdio a detached child
 * may share with this process.
 */
export function claxedoServerForkOptions(env: Record<string, string>, logFd: number): ForkOptions {
  return {
    execPath: process.execPath,
    execArgv: claxedoServerExecArgv(),
    detached: true,
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", logFd, logFd, "ipc"],
  }
}
