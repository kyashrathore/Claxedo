/**
 * What a packed tarball needs from the registry. A public package's build
 * inlines its unpublished siblings and leaves npm packages external, so the
 * tarball runs only where npm installs every package its JavaScript imports,
 * and the published manifest is the only thing that tells npm to.
 */
import fs from "node:fs"
import { builtinModules } from "node:module"
import path from "node:path"
import { buildSync } from "esbuild"
import type { PackageJson } from "./package-json"

const BUILTINS = new Set(builtinModules)

export function packageNameOf(specifier: string) {
  return specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")
}

function isBuiltin(specifier: string) {
  const bare = specifier.replace(/^node:/, "")
  return specifier.startsWith("node:") || BUILTINS.has(bare) || BUILTINS.has(bare.split("/")[0] ?? "")
}

export function scriptFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(?:m?js|cjs)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort()
}

/**
 * Every package the files import, statically, by literal `import()` or by
 * `require()`, mapped to the files (relative to `root`) that import it.
 * `require.resolve` is left out: it is a lookup the caller handles failing,
 * which is how the launch gate finds its child script.
 */
export function packageImports(root: string, files: readonly string[]) {
  const imports = new Map<string, Set<string>>()
  if (files.length === 0) return imports
  const { metafile } = buildSync({
    absWorkingDir: root,
    entryPoints: [...files],
    bundle: true,
    packages: "external",
    write: false,
    metafile: true,
    outdir: path.join(root, ".packed-imports"),
    platform: "node",
    format: "esm",
    logLevel: "silent",
  })
  for (const [importer, input] of Object.entries(metafile.inputs)) {
    for (const entry of input.imports) {
      // `<runtime>` is esbuild's own helper module, listed as an external import of a file that needs `__require`.
      if (!entry.external || entry.kind === "require-resolve" || isBuiltin(entry.path) || entry.path.startsWith("<")) continue
      const name = packageNameOf(entry.path)
      const importers = imports.get(name) ?? new Set<string>()
      importers.add(importer)
      imports.set(name, importers)
    }
  }
  return imports
}

/** Each imported package the packed manifest does not declare, with an importer that needs it. */
export function undeclaredImports(imports: ReadonlyMap<string, ReadonlySet<string>>, pkg: PackageJson) {
  const declared = new Set([
    pkg.name,
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ])
  return [...imports]
    .filter(([name]) => !declared.has(name))
    .map(([name, importers]) => `${name} (imported by ${[...importers][0]})`)
}

/**
 * Each dependency the packed manifest declares at a different version than a
 * sibling its dist bundles: the bundled code was tested against the sibling's
 * version, and npm would install the other one.
 */
export function bundledDependencyDisagreements(
  pkg: PackageJson,
  siblings: readonly PackageJson[],
  catalog: Readonly<Record<string, string>>,
) {
  const resolve = (name: string, spec: string) => (spec === "catalog:" ? catalog[name] ?? spec : spec)
  return siblings.flatMap((sibling) => Object.entries(sibling.dependencies ?? {})
    .filter(([name, spec]) => pkg.dependencies?.[name] !== undefined && !spec.startsWith("workspace:"))
    .filter(([name, spec]) => resolve(name, spec) !== resolve(name, pkg.dependencies?.[name] ?? ""))
    .map(([name, spec]) => `dependencies.${name}=${pkg.dependencies?.[name]} but bundled ${sibling.name} declares ${resolve(name, spec)}`))
}
