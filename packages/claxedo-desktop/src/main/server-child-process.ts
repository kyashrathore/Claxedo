import type { ForkOptions } from "node:child_process"

import { claxedoServerExecArgv } from "./server-runtime-policy"

export type ClaxedoServerChildInput = {
  port: number
  dataDir: string
  protocol: number
  token: string
  generation: string
  build: string
  discoveryPath: string
  compileCacheDir?: string
  /** The signed account's control plane, whose published key set signs the passes of the owner's connected machines. */
  controlPlaneOrigin?: string
}

/** The daemon's environment: this process's own, with what the daemon is told about itself on top. */
export function claxedoServerChildEnv(input: ClaxedoServerChildInput): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    CLAXEDO_CHILD_PORT: String(input.port),
    CLAXEDO_DATA_DIR: input.dataDir,
    CLAXEDO_DAEMON_PROTOCOL: String(input.protocol),
    CLAXEDO_DAEMON_TOKEN: input.token,
    CLAXEDO_DAEMON_GENERATION: input.generation,
    CLAXEDO_DAEMON_BUILD: input.build,
    CLAXEDO_DAEMON_DISCOVERY_PATH: input.discoveryPath,
    ...(input.compileCacheDir ? { CLAXEDO_CHILD_SERVER_COMPILE_CACHE_DIR: input.compileCacheDir } : {}),
    ...(input.controlPlaneOrigin ? { CLAXEDO_CONTROL_PLANE_JWKS_URL: `${input.controlPlaneOrigin}/.well-known/jwks.json` } : {}),
  }
}

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
