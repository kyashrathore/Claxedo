// Links the @claxedo/* packages from this monorepo checkout into
// node_modules so the recipes import real, local package source.
// dist/ is gitignored (published packages ship it, but a monorepo checkout
// never has it lying around), so before linking, this also builds any
// package whose dist/ is missing — in dependency order, so a package never
// builds before the sibling it imports types from.
// Outside the monorepo, set CLAXEDO_PACKAGES_ROOT to a checkout root.
import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const parent = path.resolve(root, "..")
const packageRoot = process.env.CLAXEDO_PACKAGES_ROOT ? path.resolve(process.env.CLAXEDO_PACKAGES_ROOT) : parent

// Build order matters: a package's `tsc` declaration build resolves its
// @claxedo/* imports through node_modules, which only has real .d.ts files
// once that dependency has been built. Dependencies before dependents.
const links = [
  ["@claxedo", "agent-event-runtime"],
  ["@claxedo", "workspace-relay-protocol"],
  ["@claxedo", "agent-extensions"],
  ["@claxedo", "agent-sdk-runtime"], // needs agent-event-runtime
  ["@claxedo", "workspace-relay"], // needs workspace-relay-protocol
  ["@claxedo", "workspace-runtime"], // needs agent-extensions, agent-sdk-runtime, agent-event-runtime, workspace-relay(-protocol)
  ["@claxedo", "sandbox-manager"], // needs workspace-runtime
]

fs.mkdirSync(path.join(root, "node_modules/@claxedo"), { recursive: true })

const missing = []
const npmFallback = []
for (const [scope, name] of links) {
  const target = path.join(packageRoot, "packages", name)
  const hasLocalSource = fs.existsSync(path.join(target, "package.json"))
  if (!hasLocalSource) {
    // Not a monorepo checkout (or CLAXEDO_PACKAGES_ROOT points nowhere): if
    // npm already installed a published @claxedo/<name> into node_modules,
    // that's the honest fallback — leave it alone instead of failing.
    const installed = path.join(root, "node_modules", scope, name, "package.json")
    if (fs.existsSync(installed)) {
      npmFallback.push(`${scope}/${name}`)
      continue
    }
    missing.push({ scope, name, target })
    continue
  }

  const distIndex = path.join(target, "dist")
  if (!fs.existsSync(distIndex)) {
    console.log(`[claxedo-cookbook] building ${scope}/${name} (dist/ missing) ...`)
    execSync("bun run build", { cwd: target, stdio: "inherit" })
  }

  const link = path.join(root, "node_modules", scope, name)
  fs.rmSync(link, { recursive: true, force: true })
  fs.symlinkSync(target, link, "dir")
  console.log(`[claxedo-cookbook] linked ${scope}/${name} -> ${target}`)
}

if (npmFallback.length > 0) {
  console.log(`[claxedo-cookbook] no local monorepo source found; using npm-installed packages for: ${npmFallback.join(", ")}`)
}

if (missing.length > 0) {
  console.error("[claxedo-cookbook] missing local package sources")
  console.error(`[claxedo-cookbook] package root: ${packageRoot}`)
  console.error(
    "[claxedo-cookbook] set CLAXEDO_PACKAGES_ROOT=/path/to/opencode when installing from a direct cookbook clone,",
  )
  console.error(
    "[claxedo-cookbook] or add the missing @claxedo/* packages as npm dependencies to install published versions instead",
  )
  for (const item of missing) {
    console.error(`[claxedo-cookbook] missing ${item.scope}/${item.name}: ${item.target}`)
  }
  process.exit(1)
}
