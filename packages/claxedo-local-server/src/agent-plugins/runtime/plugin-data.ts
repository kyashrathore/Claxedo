import path from "node:path"
import { createHash } from "node:crypto"

export function pluginInstanceStorageKey(pluginInstanceId: string) {
  return createHash("sha256").update(pluginInstanceId).digest("hex")
}

export function pluginDataDirectory(runtimeRoot: string, pluginInstanceId: string) {
  return path.join(runtimeRoot, "agent-plugins", "data", pluginInstanceStorageKey(pluginInstanceId))
}
