import * as fs from "node:fs"
import * as path from "node:path"

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = Bun.env.CLAXEDO_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}

export function copyIcons(channel = resolveChannel()) {
  const packageDir = path.resolve(import.meta.dir, "..")
  const src = path.resolve(packageDir, `icons/${channel}`)
  const dest = path.resolve(packageDir, "resources/icons")

  if (!fs.existsSync(src)) {
    throw new Error(`Icons dir not found at ${src}`)
  }

  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(src, dest, { recursive: true })
  return { channel, src, dest }
}

export function copyWorkspaceRuntimeTemplates(dest: string) {
  const packageDir = path.resolve(import.meta.dir, "..")
  const src = path.resolve(packageDir, "../workspace-runtime/src/agent-hooks/templates")

  if (!fs.existsSync(src)) {
    throw new Error(`Workspace runtime templates dir not found at ${src}`)
  }

  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(src, dest, { recursive: true })
  return { src, dest }
}

export const RUST_TARGET = Bun.env.RUST_TARGET
