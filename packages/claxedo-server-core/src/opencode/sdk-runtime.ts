import fs from "node:fs"
import path from "node:path"
import { createOpenCodeRuntime, WorkspaceScope, type ModelEntry, type OpenCodeRuntime } from "@claxedo/harness/opencode-sdk"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

const log = Log.create({ service: "opencode-sdk-runtime" })
let runtime: OpenCodeRuntime | undefined
let engineBound: Promise<void> | undefined

/**
 * Carry Claxedo's credential registry into the engine, once per engine.
 *
 * The bound accounts and declared providers are engine-wide state that every
 * location's catalog reads when it is set up, so one carry serves every
 * location. A failed carry is forgotten, so the next caller tries again.
 */
function bindEngineOnce(): Promise<void> {
  engineBound ??= import("./sdk-credential-bridge")
    .then((bridge) => bridge.reconcileCredentialsIntoSdk())
    .then(() => undefined, (error: unknown) => {
      engineBound = undefined
      log.warn("OpenCode SDK credential reconcile failed at boot", { error: String(error) })
    })
  return engineBound
}

/**
 * Starts the carry when the engine boots, as an SDK plugin so a cold engine is
 * never booted just to receive a credential write (see
 * `syncCredentialsToSdk`). The engine sets plugins up per location, and the
 * reconcile needs the client whose boot this setup is part of, so it runs off
 * the setup call.
 */
const credentialReconcilePlugin = {
  id: "claxedo-credential-reconcile",
  async setup() {
    setTimeout(() => void bindEngineOnce(), 0)
  },
}

function runtimeDirectory() {
  return path.join(dataDir(), "opencode-runtime")
}

/**
 * The models this process's engine can run a turn on. Read under the engine's
 * own directory: the list depends on the engine and its reconciled
 * credentials, not on any workspace. Before the first carry every bound
 * account's and declared provider's models are missing, so the read waits for it.
 */
export async function openCodeEngineModels(): Promise<readonly ModelEntry[]> {
  const current = openCodeSdkRuntime()
  const scope = WorkspaceScope.authorize({ workspaceID: "claxedo-model-catalog", directory: runtimeDirectory() })
  await current.host.client()
  await bindEngineOnce()
  return current.catalog.models(scope)
}

/** Process-owned public-SDK runtime. Construction is cold until first use. */
export function openCodeSdkRuntime(): OpenCodeRuntime {
  if (runtime) return runtime
  const directory = runtimeDirectory()
  fs.mkdirSync(directory, { recursive: true })
  runtime = createOpenCodeRuntime({
    databasePath: path.join(directory, "opencode.db"),
    persistEvents: true,
    plugins: [credentialReconcilePlugin],
    providersBound: bindEngineOnce,
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
  engineBound = undefined
  await current?.close()
}
