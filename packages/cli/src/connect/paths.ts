import path from "node:path"
import { createHostStateStore } from "@claxedo/host-connector/host-state"
import { nodeHostStateFs } from "@claxedo/host-connector/host-state-node"
import { config } from "../config"

/** The lease the control plane issues when a beat names no TTL; the beat interval derives from it. */
export const LEASE_TTL_MS = 60_000

/**
 * How long a stop signal waits for the connector's drain — the beat in
 * flight, a preparation that beat may be awaiting, then the final empty-ack
 * beat — before the runtimes are closed regardless.
 */
export const DRAIN_TIMEOUT_MS = 10_000
/** Each workspace runtime's freeze on close (`drainTimeoutMs` of the host runtime listener). */
export const RUNTIME_CLOSE_TIMEOUT_MS = 10_000
/**
 * SIGTERM to SIGKILL at the service manager: the drain and the runtime
 * closes run in sequence, then the listener's sockets close and the state
 * file is rewritten.
 */
export const EXIT_TIMEOUT_S = (DRAIN_TIMEOUT_MS + RUNTIME_CLOSE_TIMEOUT_MS) / 1000 + 5

export function connectPaths(stateDir = config().stateDir) {
  const dir = path.join(stateDir, "connect")
  return {
    dir,
    stateFile: path.join(dir, "state.json"),
    storageRoot: path.join(dir, "workspaces"),
  }
}

export function connectStateStore(stateDir = config().stateDir) {
  return createHostStateStore({ file: connectPaths(stateDir).stateFile, fs: nodeHostStateFs() })
}
