import fs from "node:fs"
import path from "node:path"
import { createOpenCodeRuntime, type OpenCodeRuntime } from "@claxedo/opencode-runtime"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"

let runtime: OpenCodeRuntime | undefined

/** Process-owned public-SDK runtime. Construction is cold until first use. */
export function openCodeSdkRuntime(): OpenCodeRuntime {
  if (runtime) return runtime
  const directory = path.join(dataDir(), "opencode-runtime")
  fs.mkdirSync(directory, { recursive: true })
  runtime = createOpenCodeRuntime({ databasePath: path.join(directory, "opencode.db"), persistEvents: true })
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
