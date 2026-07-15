import packageJson from "../package.json"

let versionCache: string | undefined

export function workspaceRuntimeVersion() {
  if (versionCache) return versionCache
  const envVersion = process.env.WORKSPACE_RUNTIME_VERSION
  if (envVersion) {
    versionCache = envVersion
    return versionCache
  }
  versionCache = packageJson.dependencies["@claxedo/workspace-runtime"]
  return versionCache
}
