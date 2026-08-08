/**
 * Where the desktop's server comes from — resolved once, for everyone.
 *
 * The desktop resolves a server in four places: `predev` (development),
 * `prebuild` + `build` (production preparation), and the boot smoke test. Unit
 * 5 retargeted them from a source-relative reach into `claxedo-server` to the
 * declared `@claxedo/local-server` package, but each one still computed the
 * answer itself. Three of four is exactly the failure this package has shipped
 * before: development works, the packaged build boots the other composition,
 * and nothing says so.
 *
 * So the answer lives here and every caller asks. That also makes the
 * resolution follow the DEPENDENCY GRAPH rather than a hard-coded sibling
 * path: `resolveLocalServerEntry` asks Node to resolve the declared specifier
 * from the desktop's own manifest, and `resolveLocalServerMigrationJournal`
 * asks again from the local-server entry, so the migration asset is owned by
 * whichever package local-server actually depends on. Move that package and
 * the bundle follows or fails loudly; it can no longer silently ship a
 * database with zero tables because a relative `../../` went stale.
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
 * `scripts/claxedo-server-entry.ts` imports this exact specifier;
 * `product-mode-contract.test.ts` holds the two together.
 */
export const LOCAL_SERVER_ENTRY = "@claxedo/local-server/self-hosted-execution"

/** Its directory, relative to this package — for source-tree inputs, not imports. */
export const LOCAL_SERVER_PACKAGE_PATH = "../claxedo-local-server"

/** The bundled artifact `prebuild`/`predev` produce and Electron main launches. */
export const LOCAL_SERVER_BUNDLE_PATH = "resources/claxedo-server"

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

/**
 * The SQL migration journal the bundled server reads at runtime.
 *
 * Resolved from the local-server entry, not from this directory: whichever
 * package local-server depends on for `platform/db` owns the journal, and the
 * bundle copies whatever that resolution names. `journal.ts` computes the
 * directory as `import.meta.dirname/claxedo-migration`, which is why the
 * directory beside the resolved module — not a path spelled out here — is the
 * authoritative location.
 */
export function resolveLocalServerMigrationJournal(desktopDir = DESKTOP_DIR): string {
  const entry = resolveLocalServerEntry(desktopDir)
  const require = createRequire(entry)
  let journalModule: string
  try {
    journalModule = require.resolve("@claxedo/server-core/platform/db/journal")
  } catch (cause) {
    throw new Error(
      `cannot resolve the migration journal module from ${LOCAL_SERVER_ENTRY} (${entry}) — ` +
        `the bundled server would open a database with no Claxedo tables.`,
      { cause },
    )
  }
  const directory = path.join(path.dirname(journalModule), "claxedo-migration")
  if (!fs.existsSync(directory)) {
    throw new Error(
      `migration journal not found at ${directory} (resolved from ${journalModule}) — ` +
        `the bundled server would open a database with no Claxedo tables.`,
    )
  }
  return directory
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
