/**
 * What the packaged app is allowed to contain, declared once.
 *
 * `electron-builder.config.ts` decides what goes IN; `verify-package-contents.ts`
 * checks what came OUT. They previously spelled the native-module set twice —
 * a list and a pair of allow-sets — so the verifier could only ever confirm
 * the answer it already held, and adding a native module to the config while
 * forgetting the verifier produced a check that passed on a package it had
 * never been taught about.
 *
 * Both now read this module, which makes the packaged artifact a closed set:
 * everything the app executes is bundled from an entry point, so the asar may
 * contain only the emitted output roots below plus the native modules that
 * cannot be bundled.
 */

import {
  DESKTOP_ACCOUNT_BOUNDARY_MANIFEST,
  DESKTOP_HOSTED_CONTRIBUTION_BOUNDARY_MANIFEST,
  REQUIRED_DESKTOP_BOUNDARY_MANIFEST_ENTRIES,
} from "./product-boundary-manifests"

/** Native modules that cannot be bundled and therefore ship as real files. */
export const NATIVE_MODULES = ["better-sqlite3", "@lydell/node-pty"] as const

/**
 * The platform-specific binary package the `@lydell/node-pty` wrapper
 * `require()`s by computed name (`@lydell/node-pty-${platform}-${arch}`).
 * Each target ships exactly one — the config picks it by target os-arch —
 * but the verifier judges asars from any target, so it allows them all.
 */
export const LYDELL_NODE_PTY_PLATFORM_PACKAGES = [
  "@lydell/node-pty-darwin-arm64",
  "@lydell/node-pty-darwin-x64",
  "@lydell/node-pty-linux-arm64",
  "@lydell/node-pty-linux-x64",
  "@lydell/node-pty-win32-arm64",
  "@lydell/node-pty-win32-x64",
] as const

/** …plus this one, which only exists on Windows targets. */
export const WINDOWS_NATIVE_MODULES = ["@vscode/windows-process-tree"] as const

/** Every native module any target may ship — the verifier's allowlist. */
export const ALL_NATIVE_MODULES: readonly string[] = [
  ...NATIVE_MODULES,
  ...LYDELL_NODE_PTY_PLATFORM_PACKAGES,
  ...WINDOWS_NATIVE_MODULES,
]

/**
 * The config keeps the Windows conditional INLINE rather than calling a helper
 * here: `src/main/diagnostics/process-metrics-source.test.ts` pins that exact
 * source line as the audited-dependency record. `package-structure.test.ts`
 * holds the inline literal and {@link WINDOWS_NATIVE_MODULES} equal, so the two
 * spellings cannot drift even though there are two of them.
 */

/**
 * The only directories of build output that ship inside the asar.
 *
 * `out` is everything electron-vite emits — main, preload, renderer, the
 * copied local-server bundle, and the workspace-runtime templates. Nothing in
 * `resources/` goes in the asar: the ACP adapters, the diagnostics helper, and
 * the OpenCode engine ship as `extraResources` beside it, because they are
 * executed as separate processes and asar paths are not real filesystem paths.
 *
 * `resources/icons` is declared but currently contributes nothing: measured on
 * a real `package:mac` run, the packaged asar holds only `out`, `package.json`
 * and the native `node_modules`, because `directories.buildResources` is
 * `resources` and electron-builder excludes that tree from `files`. The icons
 * still reach the app — `mac.icon`/`win.icon`/`linux.icon` read them at build
 * time, not through this glob. It stays declared rather than deleted because
 * removing a `files` entry is a packaging change verifiable only per platform,
 * and this check is one-directional: it rejects what is NOT declared, and does
 * not require everything declared to appear.
 */
export const ASAR_STRUCTURAL_ROOTS = ["out", "resources/icons"] as const

/**
 * Top-level files electron-builder writes itself, regardless of `files`.
 *
 * Electron requires the app manifest to locate `main`; it is not build output
 * and never appears in a glob.
 */
export const ASAR_STRUCTURAL_FILES = ["package.json"] as const

/** Separately executed Host Connector child shipped beside app.asar. */
export const HOST_CONNECTOR_EXTRA_RESOURCE = {
  from: "resources/host-connector/",
  to: "host-connector/",
  filter: ["index.js", "manifest.json"],
} as const

/** The positive `files` globs for electron-builder, derived from the roots. */
export function asarStructuralGlobs(): string[] {
  return ASAR_STRUCTURAL_ROOTS.map((root) => `${root}/**/*`)
}

/**
 * Whether one asar entry is a declared structural resource.
 *
 * `node_modules` entries are judged separately against the native allowlist —
 * they are the one exception to "bundled from an entry point".
 */
export function isDeclaredStructuralEntry(entry: string): boolean {
  if (ASAR_STRUCTURAL_FILES.includes(entry as (typeof ASAR_STRUCTURAL_FILES)[number])) return true
  return ASAR_STRUCTURAL_ROOTS.some((root) => entry === root || entry.startsWith(`${root}/`))
}

/** Build-tool evidence that must survive into the packaged asar. */
export function requiredPackagedBoundaryEntries(entries: readonly string[] = []): string[] {
  const accountShips = entries.some((entry) =>
    entry.startsWith("out/main/") && entry.includes("desktop-account-"),
  )
  const hostedContributionShips = entries.some((entry) =>
    entry.startsWith("out/renderer/") && entry.includes("desktop-hosted-contributions-"),
  )
  return [
    ...REQUIRED_DESKTOP_BOUNDARY_MANIFEST_ENTRIES,
    ...(accountShips ? [DESKTOP_ACCOUNT_BOUNDARY_MANIFEST] : []),
    ...(hostedContributionShips ? [DESKTOP_HOSTED_CONTRIBUTION_BOUNDARY_MANIFEST] : []),
  ]
}
