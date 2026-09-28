import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"

import { resolveLocalServerMigrationJournal } from "./local-server"
import { OPENCODE_SDK_EXTERNALS, stageOpenCodeSdk } from "../../workspace-runtime/scripts/stage-opencode-sdk"
import { bundleCursorWorker } from "../../harness/scripts/cursor-worker"
import { PLUGIN_TOOLCHAIN_EXTERNALS, stagePluginToolchain } from "./stage-plugin-toolchain"
import { resolveTargetOsArch } from "./target-platform"
import { runBunBuild } from "../../../script/bun-build"
import { publishedExportsPlugin } from "../../../script/published-exports-plugin"

// Native modules cannot be bundled — they ship as node_modules content. The
// public OpenCode SDK's asset-relative graph and the isolated plugin-build
// package are staged under resources/node_modules (see electron-builder.config.ts).
// Everything else is inlined.
const EXTERNAL = ["@lydell/node-pty", "better-sqlite3", ...OPENCODE_SDK_EXTERNALS, ...PLUGIN_TOOLCHAIN_EXTERNALS]

const require = createRequire(import.meta.url)

export async function bundleClaxedoServer(source: string, destination: string) {
  const pending = `${destination}.pending-${process.pid}`
  const { outputBytes } = await emitClaxedoServerBundle(source, pending)
  const [platform, arch] = resolveTargetOsArch().split("-")
  // The Cursor transport spawns its SDK worker by path: the server's code finds
  // it beside its own chunk, and the SDK the worker loads is staged with
  // OpenCode's, where Node resolves it from `chunks/`.
  const cursorWorker = await bundleCursorWorker(path.join(pending, "chunks"))
  stageOpenCodeSdk(path.join(pending, "node_modules"), { platform: platform, arch: arch }, undefined, cursorWorker.packages)
  await stagePluginToolchain(path.join(pending, "node_modules"), { platform: platform, arch: arch })

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
 * The server's own emitted code and the data files it resolves beside itself,
 * without the runtime `node_modules` that `bundleClaxedoServer` stages next to
 * it (31.7k files, 382 MiB on darwin-arm64).
 */
export async function emitClaxedoServerBundle(source: string, outdir: string) {
  fs.rmSync(outdir, { recursive: true, force: true })

  const result = await runBunBuild("Failed to bundle claxedo-server", {
    entrypoints: [source],
    outdir,
    target: "node",
    format: "esm",
    splitting: true,
    // identifiers stays OFF deliberately: this closure inlines third-party
    // packages (hono, drizzle, zod, tokentracker-cli) whose freedom from
    // function/class-name reliance we cannot prove, and mangled names would
    // also degrade server-side stack traces. Our own server code was grepped
    // clean (only `err.name === "AbortError"`, a runtime property).
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
      // Sibling packages enter this bundle as the dist an npm consumer gets, not
      // as workspace source (see the plugin header); prebuild builds them first.
      publishedExportsPlugin(),
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
  }, {
    // `bundleClaxedoServer` emits into a pid-suffixed staging directory that is
    // only promoted on success, so a failed build must remove it or nothing
    // ever collects it.
    onFailure: () => fs.rmSync(outdir, { recursive: true, force: true }),
  })

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
  for (const parent of [outdir, path.join(outdir, "chunks")]) {
    fs.cpSync(migrationsSource, path.join(parent, "claxedo-migration"), { recursive: true })
  }

  return { outputBytes }
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
  const specifiers = [...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1])
  if (specifiers.length !== 1) {
    throw new Error(
      `expected exactly one dynamic import in ${entry}, found ${specifiers.length}: ${specifiers.join(", ")}. ` +
        `The compile cache is generated from the chunk behind it; see scripts/claxedo-server-boot.ts.`,
    )
  }
  const resolved = path.resolve(path.dirname(entry), specifiers[0])
  if (!fs.existsSync(resolved)) throw new Error(`deferred server entry ${specifiers[0]} does not exist at ${resolved}`)
  return resolved
}
