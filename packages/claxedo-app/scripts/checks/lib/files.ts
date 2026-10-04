import { existsSync, readdirSync, realpathSync } from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

export const packageRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."))
export const repoRoot = resolve(packageRoot, "../..")

export type Scope = "src" | "e2e" | "scripts"

export const codeExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const
export const styleExtensions = [".css"] as const

export function listFiles(root: string, scopes: readonly Scope[], extensions: readonly string[]): string[] {
  const out: string[] = []
  for (const scope of scopes) {
    const base = join(root, scope)
    if (existsSync(base)) walkDirectory(base, scope, extensions, out)
  }
  return out.sort()
}

function walkDirectory(dir: string, scope: Scope, extensions: readonly string[], out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!skipsDirectory(full, scope)) walkDirectory(full, scope, extensions, out)
    } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) out.push(full)
  }
}

function skipsDirectory(full: string, scope: Scope): boolean {
  const name = basename(full)
  if (name === "node_modules" || name === "dist" || name === ".git") return true
  return scope === "e2e" && (name === "report" || name === "test-results")
}

export function rel(root: string, file: string): string {
  return relative(root, file).split(sep).join("/")
}

export function under(root: string, file: string, folder: string): boolean {
  const path = rel(root, file)
  return path === folder || path.startsWith(`${folder}/`)
}

export function isTranslationFile(root: string, file: string): boolean {
  const parts = rel(root, file).split("/")
  if (parts[0] !== "src" || parts[1] === "i18n") return false
  const inside = parts.slice(2)
  return inside.at(-1) === "i18n.ts" || inside.slice(0, -1).some((part) => part === "locales" || part === "i18n")
}

export function isTestFile(file: string): boolean {
  return /\.(test|vitest|spec|node-test|test-support)\.[cm]?[jt]sx?$/.test(file) || /\/(test-support|fixtures|__tests__)\//.test(file)
}

export function topFolder(root: string, file: string, scope: Scope): string | undefined {
  const path = rel(root, file)
  if (!path.startsWith(`${scope}/`)) return undefined
  const parts = path.split("/")
  return parts.length > 2 ? parts[1] : undefined
}
