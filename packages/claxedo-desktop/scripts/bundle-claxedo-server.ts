import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"

import { resolveLocalServerMigrationJournal } from "./local-server"

// Native modules cannot be bundled — they ship as the app's only node_modules
// content (see electron-builder.config.ts). Everything else is inlined.
const EXTERNAL = ["@lydell/node-pty", "better-sqlite3", "node-pty", "opencode/node-embed"]

const require = createRequire(import.meta.url)

export async function bundleClaxedoServer(source: string, destination: string) {
  const pending = `${destination}.pending-${process.pid}`
  fs.rmSync(pending, { recursive: true, force: true })

  const result = await Bun.build({
    entrypoints: [source],
    outdir: pending,
    target: "node",
    format: "esm",
    splitting: true,
    minify: {
      syntax: true,
      whitespace: true,
    },
    naming: {
      entry: "index.[ext]",
      chunk: "chunks/[name]-[hash].[ext]",
    },
    external: EXTERNAL,
    plugins: [
      {
        name: "jsonc-parser-esm",
        setup(build) {
          // jsonc-parser's default entry is UMD: Bun cannot see the relative
          // requires hidden inside the UMD factory closure, and they leak as
          // runtime requires that resolve nowhere in a bundled app. The ESM
          // entry is statically analyzable and inlines cleanly.
          build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
            path: require.resolve("jsonc-parser/lib/esm/main.js"),
          }))
        },
      },
    ],
  })

  if (!result.success) {
    fs.rmSync(pending, { recursive: true, force: true })
    throw new AggregateError(result.logs, "Failed to bundle claxedo-server")
  }

  const outputBytes = result.outputs.reduce((total, output) => total + fs.statSync(output.path).size, 0)

  // `journal.ts` resolves SQL migrations at runtime relative to
  // import.meta.dirname (claxedo-migration next to the compiled module).
  // Bundling moves the module into chunks/ without its data directory, so a
  // fresh profile opened a database with ZERO claxedo tables. Ship the
  // migration journal next to both candidate dirnames (entry root and chunks/).
  //
  // Located through the local-server package rather than a `../../` reach into
  // a sibling source tree: the desktop's server is `@claxedo/local-server`, so
  // whichever package IT depends on for `platform/db` owns this asset. A
  // relative path would keep resolving after that edge moved, and the only
  // symptom is an empty database on a fresh profile.
  const migrationsSource = resolveLocalServerMigrationJournal()
  for (const parent of [pending, path.join(pending, "chunks")]) {
    fs.cpSync(migrationsSource, path.join(parent, "claxedo-migration"), { recursive: true })
  }

  fs.rmSync(destination, { recursive: true, force: true })
  fs.renameSync(pending, destination)
  fs.rmSync(`${destination}.js`, { force: true })

  const entry = path.join(destination, "index.js")
  return {
    entry,
    /**
     * The chunk `index.js` reaches by dynamic import — i.e. the product entry,
     * and with it the whole 9.11 MB static closure the shipped compile cache is
     * generated from.
     *
     * The build needs this because the boot stub REFUSES to run without a valid
     * server environment, so a generator that entered through `index.js` would
     * throw before the dynamic import and cache nothing. It enters here
     * instead. Read back out of the emitted entry rather than predicted from
     * the bundler's options: the chunk name carries a content hash, and a
     * predicted name that drifted would silently generate an empty cache.
     */
    deferredEntry: resolveDeferredServerEntry(entry),
    outputBytes,
  }
}

/**
 * The single dynamic import the boot stub emits, resolved to a real file.
 *
 * Exported because a preparation script that finds the bundle already current
 * still has to name this chunk to regenerate the cache, and re-deriving it from
 * the emitted entry is the only spelling that cannot drift from the bundle.
 *
 * Asserted to be exactly one: the stub has exactly one `await import()` by
 * construction, so zero means the bundler inlined it (and the cache boundary is
 * gone), and more than one means the stub grew a second deferred edge that this
 * function would otherwise pick between at random.
 */
export function resolveDeferredServerEntry(entry: string) {
  const source = fs.readFileSync(entry, "utf8")
  const specifiers = [...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]!)
  if (specifiers.length !== 1) {
    throw new Error(
      `expected exactly one dynamic import in ${entry}, found ${specifiers.length}: ${specifiers.join(", ")}. ` +
        `The compile cache is generated from the chunk behind it; see scripts/claxedo-server-boot.ts.`,
    )
  }
  const resolved = path.resolve(path.dirname(entry), specifiers[0]!)
  if (!fs.existsSync(resolved)) throw new Error(`deferred server entry ${specifiers[0]} does not exist at ${resolved}`)
  return resolved
}

export async function bundleClaxedoEngineWorker(source: string, destination: string) {
  const result = await Bun.build({
    entrypoints: [source],
    outdir: destination,
    target: "node",
    format: "esm",
    naming: "index.[ext]",
  })
  if (!result.success) throw new AggregateError(result.logs, "Failed to bundle claxedo engine worker")
  return path.join(destination, "index.js")
}
