import path from "node:path"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { parseRecoveryOutcome, type RecoveryOutcome } from "@claxedo/agent-runtime-contract"
import { verifyCreationIdentity } from "@claxedo/agent-sdk-runtime/launch"
import {
  CLAXEDO_DAEMON_PROTOCOL,
  DAEMON_PROTOCOL_HEADER,
  claxedoDaemonDiscoveryPath,
  readClaxedoDaemonDiscovery,
  verifyClaxedoDaemonDiscovery,
} from "../../../claxedo-desktop/src/main/server-daemon-discovery"

/**
 * Final teardown only: restart checks must leave the daemon and its PTYs alive.
 *
 * The daemon is asked to drain and then to stop, which is the same two-step any
 * other caller takes. Whether it is gone is read from the recorded creation
 * identity rather than from `kill(pid, 0)`: a test profile's pid is as reusable
 * as any other, and "some process holds that number" is not this daemon.
 */
export async function shutdownPackagedTestDaemon(userDataDir: string, removeTerminals: () => Promise<void> = async () => {}) {
  const file = claxedoDaemonDiscoveryPath(path.join(userDataDir, "server-data"))
  const record = readClaxedoDaemonDiscovery(file)
  if (!record) {
    if (existsSync(file)) throw new Error("Test daemon discovery is invalid; refusing shutdown")
    return
  }
  if (!record.identity) throw new Error("Test daemon published no creation identity; refusing shutdown")
  if ((await verifyCreationIdentity(record.identity)).state === "exited") return
  const origin = await verifyClaxedoDaemonDiscovery(record)
  if (!origin) throw new Error("Test daemon identity could not be verified; refusing shutdown")

  const submit = async (action: "drain_daemon" | "stop_daemon", scopeRevision: string): Promise<RecoveryOutcome> => {
    const response = await fetch(`${origin}/api/claxedo/daemon/recovery`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${record.token}`,
        "content-type": "application/json",
        [DAEMON_PROTOCOL_HEADER]: String(CLAXEDO_DAEMON_PROTOCOL),
      },
      body: JSON.stringify({
        requestId: `e2e-${action}-${randomUUID()}`,
        action,
        target: { scope: "machine", machineId: "local", ownerGeneration: record.generation },
        scopeRevision,
        attempt: 1,
      }),
    })
    return parseRecoveryOutcome(await response.text())
  }

  const inspect = async () => {
    const response = await fetch(`${origin}/api/claxedo/daemon/recovery`, {
      headers: {
        authorization: `Bearer ${record.token}`,
        [DAEMON_PROTOCOL_HEADER]: String(CLAXEDO_DAEMON_PROTOCOL),
      },
    })
    return await response.json() as { scopeRevision: string; preview: { resources: string[] } }
  }

  await removeTerminals()
  const drained = await submit("drain_daemon", (await inspect()).scopeRevision)
  if (drained.kind === "refused") throw new Error(`Test daemon refused the drain: ${drained.refusal.message}`)

  // The stop runs against the scope the drain left, so a terminal that
  // reappeared between the two is a refusal rather than a silent widening.
  const after = await inspect()
  const stopped = await submit("stop_daemon", after.scopeRevision)
  if (stopped.kind === "refused") {
    throw new Error(`Test daemon refused the stop (${stopped.refusal.kind}): ${stopped.refusal.message}; still held: ${
      after.preview.resources.join("; ")
    }`)
  }

  const deadline = Date.now() + 30_000
  for (;;) {
    if ((await verifyCreationIdentity(record.identity)).state !== "live") return
    if (Date.now() >= deadline) {
      throw new Error("Test daemon did not exit after an authorized stop; keep the profile for diagnosis")
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
