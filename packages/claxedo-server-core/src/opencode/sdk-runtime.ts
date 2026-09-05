import fs from "node:fs"
import path from "node:path"
import { createOpenCodeRuntime, type OpenCodeRuntime } from "@claxedo/workspace-runtime/opencode"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

const log = Log.create({ service: "opencode-sdk-runtime" })
let runtime: OpenCodeRuntime | undefined

/**
 * Carry Claxedo's credential registry into the SDK when the host boots.
 *
 * Runs as an SDK plugin so a cold host is never booted just to receive a
 * credential write (see `syncCredentialsToSdk`). The reconcile is scheduled
 * off the setup call: it needs the client whose boot this setup is part of.
 */
const credentialReconcilePlugin = {
  id: "claxedo-credential-reconcile",
  async setup() {
    setTimeout(() => {
      void import("./sdk-credential-bridge")
        .then((bridge) => bridge.reconcileCredentialsIntoSdk())
        .catch((error) => log.warn("OpenCode SDK credential reconcile failed at boot", { error: String(error) }))
    }, 0)
  },
}

/** Process-owned public-SDK runtime. Construction is cold until first use. */
export function openCodeSdkRuntime(): OpenCodeRuntime {
  if (runtime) return runtime
  const directory = path.join(dataDir(), "opencode-runtime")
  fs.mkdirSync(directory, { recursive: true })
  runtime = createOpenCodeRuntime({
    databasePath: path.join(directory, "opencode.db"),
    persistEvents: true,
    plugins: [credentialReconcilePlugin],
  })
  return runtime
}

export function openCodeSdkRuntimeLoaded(): boolean {
  const lifecycle = runtime?.host.status().lifecycle
  return lifecycle === "ready" || lifecycle === "draining"
}

export async function drainOpenCodeSdkRuntime(): Promise<void> {
  const current = runtime
  runtime = undefined
  await current?.close()
}
