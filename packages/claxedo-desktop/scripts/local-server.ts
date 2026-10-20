/**
 * Where the desktop's server comes from — resolved once, for everyone.
 *
 * Artifact preparation (`predev` and `prebuild`), `build` and the boot smoke
 * test all ask here, so development and the packaged build cannot boot
 * different compositions. The resolution follows the DEPENDENCY GRAPH rather
 * than a hard-coded sibling path: `resolveLocalServerEntry` asks Node to
 * resolve the declared specifier from the desktop's own manifest, and
 * `resolveServerMigrationJournals` asks again from the local-server entry and
 * from this package, so each migration asset is owned by whichever package
 * actually carries it. Move that package and the bundle follows or fails loudly; a
 * stale relative `../../` would instead ship a database with zero tables.
 *
 * Every failure here names the artifact it could not find. A desktop that
 * cannot find its local server must say which one and stop — there is no
 * second server to fall back to, and starting one would be the hosted product.
 */

import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"

/** The package that IS the desktop's server. */
export const LOCAL_SERVER_PACKAGE = "@claxedo/local-server"

/**
 * The declared entry the desktop server child imports.
 *
 * `src/server/entry.ts` imports this exact specifier;
 * `product-mode-contract.test.ts` holds the two together.
 */
export const LOCAL_SERVER_ENTRY = "@claxedo/local-server/self-hosted-execution"

/** Its directory, relative to this package — for source-tree inputs, not imports. */
export const LOCAL_SERVER_PACKAGE_PATH = "../claxedo-local-server"

/** The bundled artifact `prepare-artifacts.ts` produces and Electron main launches. */
export const LOCAL_SERVER_BUNDLE_PATH = "resources/claxedo-server"

/**
 * The server child's bundle entry: the boot stub that seeds the compile cache
 * and then reaches `src/server/entry.ts` through a dynamic import.
 */
export const LOCAL_SERVER_BOOT_SOURCE_PATH = "src/server/boot.ts"

const DESKTOP_DIR = path.resolve(import.meta.dirname, "..")

/** The local-server source tree, for staleness inputs and contract fingerprints. */
export function localServerPackageDir(desktopDir = DESKTOP_DIR) {
  return path.resolve(desktopDir, LOCAL_SERVER_PACKAGE_PATH)
}

/**
 * The resolved file behind {@link LOCAL_SERVER_ENTRY}.
 *
 * Resolution runs from the desktop's own `package.json`, so it fails exactly
 * when the declared dependency edge is missing — the case a relative path
 * cannot detect at all.
 */
export function resolveLocalServerEntry(desktopDir = DESKTOP_DIR): string {
  const require = createRequire(path.join(desktopDir, "package.json"))
  try {
    return require.resolve(LOCAL_SERVER_ENTRY)
  } catch (cause) {
    throw new Error(
      `cannot resolve ${LOCAL_SERVER_ENTRY} from ${desktopDir} — the desktop server is ` +
        `${LOCAL_SERVER_PACKAGE} and there is no fallback server to start. ` +
        `Check the dependency in package.json and run \`bun install\`.`,
      { cause },
    )
  }
}

/** One migration journal the bundled server reads at runtime, and the directory name it is copied under. */
export type ServerMigrationJournal = { name: string; directory: string }

/**
 * Each journal a module beside the bundled server resolves at runtime as
 * `import.meta.dirname/<name>`: the host's `claxedo-migration`, resolved from
 * the local-server entry because whichever package local-server depends on for
 * `platform/db` owns it, and each composed plugin's, resolved from this
 * package because `src/server/entry.ts` composes the plugin. The bundle copies
 * each directory under its own name, so the names must differ, and a migration
 * name two journals share would be refused at boot, so it is refused here.
 */
export function resolveServerMigrationJournals(desktopDir = DESKTOP_DIR): ServerMigrationJournal[] {
  const fromServer = createRequire(resolveLocalServerEntry(desktopDir))
  const fromDesktop = createRequire(path.join(desktopDir, "package.json"))
  const journals = [
    journalBeside(fromServer, "@claxedo/server-core/platform/db/journal", "claxedo-migration"),
    journalBeside(fromDesktop, "@claxedo/tasks/storage/sqlite", "claxedo-tasks-migration"),
  ]
  const owners = new Map<string, string>()
  for (const journal of journals) {
    for (const migration of fs.readdirSync(journal.directory)) {
      const owner = owners.get(migration)
      if (owner) throw new Error(`migration ${migration} is in two journals: ${owner} and ${journal.directory}`)
      owners.set(migration, journal.directory)
    }
  }
  return journals
}

function journalBeside(require: NodeJS.Require, specifier: string, name: string): ServerMigrationJournal {
  let journalModule: string
  try {
    journalModule = require.resolve(specifier)
  } catch (cause) {
    throw new Error(
      `cannot resolve the migration journal module ${specifier} — the bundled server would open a database without its tables.`,
      { cause },
    )
  }
  const directory = path.join(path.dirname(journalModule), name)
  if (!fs.existsSync(directory) || fs.readdirSync(directory).length === 0) {
    throw new Error(
      `migration journal not found at ${directory} (resolved from ${journalModule}) — ` +
        `the bundled server would open a database without its tables.`,
    )
  }
  return { name, directory }
}

export function localServerBootSource(desktopDir = DESKTOP_DIR): string {
  return path.join(desktopDir, LOCAL_SERVER_BOOT_SOURCE_PATH)
}

/** The bundled server's entry file, wherever the desktop package lives. */
export function localServerBundleEntry(desktopDir = DESKTOP_DIR): string {
  return path.join(desktopDir, LOCAL_SERVER_BUNDLE_PATH, "index.js")
}

/**
 * The bundled server's entry file, or a failure that names it.
 *
 * Electron main applies the same rule at launch (`startClaxedoServer` throws
 * on a missing bundle rather than reaching for another server). Preparation
 * must not be laxer than launch: a build that quietly proceeds without the
 * artifact produces an installer whose server is simply absent.
 */
export function requireLocalServerBundle(desktopDir = DESKTOP_DIR): string {
  const entry = localServerBundleEntry(desktopDir)
  if (!fs.existsSync(entry)) {
    throw new Error(
      `${LOCAL_SERVER_PACKAGE} bundle not found at ${entry} — run \`bun run prebuild\` ` +
        `(or \`bun run predev\`) first. No other server is started in its place.`,
    )
  }
  return entry
}
