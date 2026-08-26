import { existsSync } from "node:fs"
import { join } from "node:path"

export function richContentRendererBinaryName(platform = process.platform) {
  return platform === "win32" ? "claxedo-rich-content-renderer.exe" : "claxedo-rich-content-renderer"
}

export function resolveRichContentRendererPath(input: {
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
  const binary = richContentRendererBinaryName(platform)
  const candidates = [
    input.override,
    input.packaged
      ? join(input.resourcesPath, "rich-content", binary)
      : join(input.appPath, "resources", "rich-content", `${platform}-${arch}`, binary),
  ].filter((path): path is string => !!path)
  return candidates.find(input.exists ?? existsSync)
}
