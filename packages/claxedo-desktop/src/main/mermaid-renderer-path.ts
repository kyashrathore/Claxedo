import { existsSync } from "node:fs"
import { join } from "node:path"

export function mermaidRendererBinaryName(platform = process.platform) {
  return platform === "win32" ? "claxedo-mermaid-renderer.exe" : "claxedo-mermaid-renderer"
}

export function resolveMermaidRendererPath(input: {
  packaged: boolean
  resourcesPath: string
  appPath: string
  platform?: NodeJS.Platform
  arch?: string
  override?: string
  exists?: (path: string) => boolean
}) {
  const platform = input.platform ?? process.platform
  const arch = (input.arch ?? process.arch) === "arm64" ? "arm64" : "x64"
  const binary = mermaidRendererBinaryName(platform)
  const candidates = [
    input.override,
    input.packaged
      ? join(input.resourcesPath, "mermaid", binary)
      : join(input.appPath, "resources", "mermaid", `${platform}-${arch}`, binary),
  ].filter((path): path is string => !!path)
  return candidates.find(input.exists ?? existsSync)
}
