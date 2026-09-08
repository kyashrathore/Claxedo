import path from "node:path"
import { existsSync } from "node:fs"
import {
  claxedoDaemonDiscoveryPath,
  publishedDaemonProcessIsAlive,
  readClaxedoDaemonDiscovery,
  verifyClaxedoDaemonDiscovery,
} from "../../../claxedo-desktop/src/main/server-daemon-discovery"
import { holdClaxedoDaemonLease } from "../../../claxedo-desktop/src/main/server-daemon-lease"

/** Final teardown only: restart checks must leave the daemon and its PTYs alive. */
export async function shutdownPackagedTestDaemon(userDataDir: string, removeTerminals: () => Promise<void> = async () => {}) {
  const file = claxedoDaemonDiscoveryPath(path.join(userDataDir, "server-data"))
  const record = readClaxedoDaemonDiscovery(file)
  if (!record) {
    if (existsSync(file)) throw new Error("Test daemon discovery is invalid; refusing shutdown")
    return
  }
  if (!publishedDaemonProcessIsAlive(record.pid)) return
  if (!await verifyClaxedoDaemonDiscovery(record)) {
    throw new Error("Test daemon identity could not be verified; refusing shutdown")
  }
  let failure: unknown
  const lease = await holdClaxedoDaemonLease(record, { onError: (error) => { failure = error } })
  try {
    await removeTerminals()
  } finally {
    await lease.shutdown()
  }
  if (failure) throw failure
  const deadline = Date.now() + 30_000
  while (publishedDaemonProcessIsAlive(record.pid)) {
    if (Date.now() >= deadline) throw new Error("Test daemon did not exit after authenticated shutdown; keep the profile for diagnosis")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
