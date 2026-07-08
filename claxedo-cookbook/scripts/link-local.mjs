// Links the @claxedo/* packages from this monorepo checkout into
// node_modules so the recipes import real, local package source.
// Outside the monorepo, set CLAXEDO_PACKAGES_ROOT to a checkout root.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const parent = path.resolve(root, "..")
const packageRoot = process.env.CLAXEDO_PACKAGES_ROOT ? path.resolve(process.env.CLAXEDO_PACKAGES_ROOT) : parent

const links = [
  ["@claxedo", "agent-event-runtime"],
  ["@claxedo", "agent-sdk-runtime"],
  ["@claxedo", "agent-extensions"],
  ["@claxedo", "sandbox-manager"],
  ["@claxedo", "workspace-relay"],
  ["@claxedo", "workspace-relay-protocol"],
  ["@claxedo", "workspace-runtime"],
]

fs.mkdirSync(path.join(root, "node_modules/@claxedo"), { recursive: true })

const missing = []
for (const [scope, name] of links) {
  const target = path.join(packageRoot, "packages", name)
  if (!fs.existsSync(path.join(target, "package.json"))) {
    missing.push({ scope, name, target })
    continue
  }
  const link = path.join(root, "node_modules", scope, name)
  fs.rmSync(link, { recursive: true, force: true })
  fs.symlinkSync(target, link, "dir")
  console.log(`[claxedo-cookbook] linked ${scope}/${name} -> ${target}`)
}

if (missing.length > 0) {
  console.error("[claxedo-cookbook] missing local package sources")
  console.error(`[claxedo-cookbook] package root: ${packageRoot}`)
  console.error(
    "[claxedo-cookbook] set CLAXEDO_PACKAGES_ROOT=/path/to/opencode when installing from a direct cookbook clone",
  )
  for (const item of missing) {
    console.error(`[claxedo-cookbook] missing ${item.scope}/${item.name}: ${item.target}`)
  }
  process.exit(1)
}
