import fs from "fs"
import path from "path"

export function workspaceRuntimeBinDir() {
  const fallback = path.resolve(process.cwd(), "node_modules/.bin")
  const candidates = [
    path.resolve(import.meta.dirname, "../node_modules/.bin"),
    path.resolve(import.meta.dirname, "../../../.bin"),
    fallback,
  ]
  return candidates.find((dir) => fs.existsSync(dir)) ?? fallback
}

export function prependWorkspaceRuntimeBin(input: string | undefined) {
  const bin = workspaceRuntimeBinDir()
  const paths = (input ?? "").split(path.delimiter).filter(Boolean)
  if (paths.includes(bin)) return input ?? bin
  return [bin, ...paths].join(path.delimiter)
}
