import path from "node:path"
import { createHostStateStore } from "@claxedo/host-connector/host-state"
import { nodeHostStateFs } from "@claxedo/host-connector/host-state-node"
import { config } from "../config"

/** The lease the control plane issues when a beat names no TTL; the beat interval and `status` derive from it. */
export const LEASE_TTL_MS = 60_000

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
