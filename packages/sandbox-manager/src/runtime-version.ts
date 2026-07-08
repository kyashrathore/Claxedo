import { createRequire } from "module"

const require = createRequire(import.meta.url)

let versionCache: string | undefined

export function workspaceRuntimeVersion() {
  if (versionCache) return versionCache
  const envVersion = process.env.WORKSPACE_RUNTIME_VERSION
  if (envVersion) {
    versionCache = envVersion
    return versionCache
  }
  try {
    versionCache = require("@claxedo/workspace-runtime/package.json").version as string
    return versionCache
  } catch {}
  versionCache = "0.0.0"
  return versionCache
}
