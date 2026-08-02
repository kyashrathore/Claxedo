import path from "path"
import type { MaterializedRuntimeRecord } from "../materialization"
import { linkOrCopyOwnedDirectory } from "../materialization"

export function cursorLocalPluginDir(input: {
  homeDir: string
  pluginName: string
}) {
  return path.join(input.homeDir, ".cursor", "plugins", "local", input.pluginName)
}

export async function materializeCursorLocalPlugin(input: {
  packageDir: string
  pluginName: string
  ownerId: string
  homeDir: string
  record?: MaterializedRuntimeRecord
  replaceOwned?: boolean
  symlink?: (source: string, target: string, type: "dir") => Promise<void>
}) {
  const result = await linkOrCopyOwnedDirectory({
    sourceDir: input.packageDir,
    targetDir: cursorLocalPluginDir(input),
    ownerId: input.ownerId,
    record: input.record,
    ...(input.replaceOwned ? { replaceOwned: input.replaceOwned } : {}),
    ...(input.symlink ? { symlink: input.symlink } : {}),
  })
  return {
    runner: "cursor" as const,
    component: input.pluginName,
    type: "plugin" as const,
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    path: result.path,
  }
}
