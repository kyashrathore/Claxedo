import { existsSync, readdirSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

export const packageRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."))
export const repoRoot = resolve(packageRoot, "../..")

export type Scope = "src" | "e2e" | "plugins" | "scripts"

export const codeExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const
export const styleExtensions = [".css"] as const

export type Args = { readonly root: string; readonly rest: readonly string[] }

export function parseArgs(argv: readonly string[]): Args {
  let root = packageRoot
  const rest: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--root") {
      root = realpathSync(resolve(argv[index + 1] ?? "."))
      index += 1
    } else if (argument !== undefined) rest.push(argument)
  }
  return { root, rest }
}

export function pluginsDirectory(root: string): string {
  return root === packageRoot ? join(repoRoot, "plugins") : join(root, "plugins")
}

export function listFiles(root: string, scopes: readonly Scope[], extensions: readonly string[]): string[] {
  const out: string[] = []
  for (const scope of scopes) {
    const base = scope === "plugins" ? pluginsDirectory(root) : join(root, scope)
    if (existsSync(base)) walkDirectory(base, scope, root, extensions, out)
  }
  return out.sort()
}

function walkDirectory(dir: string, scope: Scope, root: string, extensions: readonly string[], out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!skipsDirectory(full, scope, root)) walkDirectory(full, scope, root, extensions, out)
    } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) out.push(full)
  }
}

function skipsDirectory(full: string, scope: Scope, root: string): boolean {
  const name = basename(full)
  if (name === "node_modules" || name === "dist" || name === ".git") return true
  if (rel(root, full) === `${scope}/legacy`) return true
  return scope === "e2e" && (name === "report" || name === "test-results")
}

export function rel(root: string, file: string): string {
  const inPlugins = relative(pluginsDirectory(root), file)
  const path = inPlugins.startsWith("..") || isAbsolute(inPlugins) ? relative(root, file) : join("plugins", inPlugins)
  return path.split(sep).join("/")
}

export function shown(root: string, file: string): string {
  return relative(root, file).split(sep).join("/")
}

export function under(root: string, file: string, folder: string): boolean {
  const path = rel(root, file)
  return path === folder || path.startsWith(`${folder}/`)
}

export function isTranslationFile(root: string, file: string): boolean {
  const parts = rel(root, file).split("/")
  if (parts[0] !== "src" && parts[0] !== "plugins") return false
  if (parts[0] === "src" && parts[1] === "i18n") return false
  const inside = parts.slice(2)
  return inside.at(-1) === "i18n.ts" || inside.slice(0, -1).some((part) => part === "locales" || part === "i18n")
}

export function topFolder(root: string, file: string, scope: Scope): string | undefined {
  const path = rel(root, file)
  if (!path.startsWith(`${scope}/`)) return undefined
  const parts = path.split("/")
  return parts.length > 2 ? parts[1] : undefined
}
