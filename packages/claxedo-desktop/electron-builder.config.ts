import type { Configuration } from "electron-builder"
import { existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

import { resolveTargetOsArch } from "./scripts/target-platform"

const channel = (() => {
  const raw = process.env.CLAXEDO_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

// Node-style os-arch for the build TARGET, so the native module set below
// can include platform-conditional entries (Windows-only process tree).
const targetOsArch = resolveTargetOsArch()
// Everything the app executes is bundled from entry points at build time
// (electron-vite main/preload/renderer, Bun.build for claxedo-server), so no
// node_modules ship — except native modules, which cannot be bundled. This is
// the packaging invariant; scripts/verify-package-contents.ts enforces it.
const NATIVE_MODULES = [
  "better-sqlite3",
  "node-pty",
  "@lydell/node-pty",
  ...(targetOsArch.startsWith("win32-") ? ["@vscode/windows-process-tree"] : []),
]

// Native prebuilds ship one variant per package per target — the loader picks
// by exact platform-arch name, so foreign-arch variants are dead weight.
// better-sqlite3's deps/ holds the sqlite3.c build source: only needed for
// node-gyp rebuilds, never at runtime.
const NATIVE_PLATFORM_FILES = [
  `**/node_modules/better-sqlite3/prebuilds/${targetOsArch}.node`,
  `**/node_modules/node-pty/prebuilds/${targetOsArch}/**`,
]

// Absolute directory of `@lydell/node-pty-<platform>-<arch>` for the build
// TARGET. bun keeps this optionalDependency only inside its version-pinned
// `node_modules/.bun/<name>@<version>/` store and never symlinks it anywhere a
// normal resolve would reach, so scan the store rather than hardcoding a path
// that would silently rot on the next dependency bump.
const PTY_PLATFORM_PACKAGE_DIR = (() => {
  const name = `@lydell/node-pty-${targetOsArch}`
  const store = resolve(import.meta.dirname, "../../node_modules/.bun")
  const prefix = `${name.replace("/", "+")}@`
  const match = existsSync(store)
    ? readdirSync(store)
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => join(store, entry, "node_modules", name))
        .find((dir) => existsSync(join(dir, "package.json")))
    : undefined
  if (!match) {
    // Fail the build rather than ship an engine that cannot load. A silent
    // miss here is precisely how v0.0.64 shipped with an empty model picker.
    throw new Error(
      `cannot locate ${name} under ${store} — the embedded engine imports ` +
        `@lydell/node-pty at the top level and will fail to load without it. ` +
        `Run \`bun install\` for this target, or update this lookup.`,
    )
  }
  return `${match}/`
})()

// Chromium-internal UI strings (menus, permission prompts, error pages) in the
// app's own languages; every other locale is deleted from the bundle. The app's
// own translations live in the renderer bundle, not here.
//
// electron-builder deletes any locale whose filename is not an EXACT match in
// this list (ElectronFramework.ts: `wantedLanguages.includes(basename)`), and
// the two platform families do NOT name locales the same way:
//
//   macOS   `.lproj` dirs, underscores, mostly bare language: en, en_GB, zh_CN
//   win/lin `.pak` files, hyphens and regions:             en-US, en-GB, zh-CN
//
// Shipping one hyphenated list for both silently dropped SIX locales from the
// mac build — including `en-US`, whose mac name is plain `en`. With no English
// pak in the bundle, Chromium fell back to another bundled locale, so
// `navigator.language` reported (say) German on an en-IN machine and the
// renderer faithfully rendered its German dictionary. A wrong name here is a
// silent delete, never a build error, so these lists MUST be verified against
// the real bundle — scripts/verify-package-contents.ts asserts English survives.
//
// Keep both lists in sync with renderer/i18n LOCALES. `bs` (Bosnian) is
// deliberately absent: Electron ships no such locale, so the app's own Bosnian
// dictionary is served with English Chromium chrome.
const MAC_ELECTRON_LANGUAGES = [
  "en",
  "en_GB",
  "zh_CN",
  "zh_TW",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "ar",
  "nb",
  "pt_BR",
]

const PAK_ELECTRON_LANGUAGES = [
  "en-US",
  "en-GB",
  "zh-CN",
  "zh-TW",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "ar",
  "nb",
  "pt-BR",
]

const getBase = (): Configuration => ({
  artifactName: "claxedo-desktop-${os}-${arch}.${ext}",
  // Never node-gyp-rebuild the workspace's native deps against Electron's
  // headers. Everything native that SHIPS is a prebuild selected by
  // NATIVE_PLATFORM_FILES; the rebuild step only recompiles modules that are
  // excluded from the bundle anyway — and it hard-fails on ones whose C++
  // doesn't compile against Electron's V8 (node-liblzma, an optional dep of
  // just-bash, killed both Linux release legs exactly this way).
  npmRebuild: false,
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: [
    "out/**/*",
    "resources/icons/**/*",
    "!**/node_modules/**",
    ...NATIVE_MODULES.map((name) => `**/node_modules/${name}/**`),
    "!**/node_modules/better-sqlite3/deps/**",
    "!**/node_modules/better-sqlite3/prebuilds/**",
    "!**/node_modules/node-pty/prebuilds/**",
    ...NATIVE_PLATFORM_FILES,
  ],
  asarUnpack: NATIVE_MODULES.map((name) => `**/node_modules/${name}/**`),
  extraResources: [
    ...(targetOsArch.startsWith("darwin-")
      ? [{ from: "resources/diagnostics/", to: "diagnostics/", filter: ["macos-memory-impact"] }]
      : []),
    {
      from: "resources/acp/",
      to: "acp/",
      filter: ["**/*"],
    },
    {
      // The claxedo-server bundle externalizes `opencode/node-embed`; the
      // desktop main process points the utility process at this explicit
      // artifact path (CLAXEDO_CHILD_OPENCODE_EMBED_PATH). Source maps stay
      // out of the installer.
      from: "../opencode/dist/node/",
      to: "opencode-engine/",
      filter: ["**/*", "!**/*.map"],
    },
    {
      // The engine keeps ONE external (`@lydell/node-pty` — a native module
      // that cannot be bundled), imported bare at the top level of node.js.
      // Node resolves a bare import by walking UP from the importing file, and
      // the engine lives at Resources/opencode-engine/ — a SIBLING of
      // Resources/app.asar.unpacked/node_modules, never an ancestor. So the
      // unpacked natives are invisible to it and the import throws
      // ERR_MODULE_NOT_FOUND, taking the whole engine module down with it.
      //
      // A top-level import failing means EVERY engine-backed route degrades to
      // its empty fallback: `/config/providers` answers `{providers: []}` and
      // the model picker shows "No model results" with no error anywhere the
      // user or the logs can see. Shipping node_modules directly beside the
      // engine puts the package on its own resolution path.
      // Package-local path, not the workspace root: bun stores the real
      // directory under a version-pinned `node_modules/.bun/@lydell+node-pty@<v>/`
      // path that changes on every upgrade, while this symlink is stable.
      from: "node_modules/@lydell/node-pty/",
      to: "opencode-engine/node_modules/@lydell/node-pty/",
      filter: ["**/*"],
    },
    {
      // ...and the platform-specific binary it `require()`s by computed name
      // (`@lydell/node-pty-${process.platform}-${process.arch}`). Shipping the
      // wrapper alone is not enough — it throws "could not find the
      // platform-specific package" and takes the engine down exactly as a
      // missing wrapper would. bun leaves this optionalDependency unlinked at
      // every level a normal resolve reaches, so the path is located on disk.
      from: PTY_PLATFORM_PACKAGE_DIR,
      to: `opencode-engine/node_modules/@lydell/node-pty-${targetOsArch}/`,
      filter: ["**/*"],
    },
  ],
  mac: {
    // `.lproj` names, not the `.pak` names win/linux use — see the lists above.
    electronLanguages: MAC_ELECTRON_LANGUAGES,
    category: "public.app-category.developer-tools",
    icon: "resources/icons/icon.icns",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "Claxedo",
    schemes: ["claxedo"],
  },
  win: {
    electronLanguages: PAK_ELECTRON_LANGUAGES,
    icon: "resources/icons/icon.ico",
    target: ["nsis"],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: "resources/icons/icon.ico",
    installerHeaderIcon: "resources/icons/icon.ico",
  },
  linux: {
    electronLanguages: PAK_ELECTRON_LANGUAGES,
    icon: "resources/icons",
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
    // Explicit, not defaulted: the default derives from package.json's name
    // ("@claxedo/desktop") through a sanitizer, which produced a binary name
    // no tooling predicted — the packaged diagnostics smoke spent two release
    // rounds guessing at it. Pinning makes the binary path a contract.
    executableName: "claxedo",
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: "ai.claxedo.desktop.dev",
        productName: "Claxedo Dev",
        rpm: { packageName: "claxedo-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "ai.claxedo.desktop.beta",
        productName: "Claxedo Beta",
        protocols: { name: "Claxedo Beta", schemes: ["claxedo"] },
        publish: { provider: "github", owner: "kyashrathore", repo: "Claxedo", channel: "latest" },
        rpm: { packageName: "claxedo-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "ai.claxedo.desktop",
        productName: "Claxedo",
        protocols: { name: "Claxedo", schemes: ["claxedo"] },
        publish: { provider: "github", owner: "kyashrathore", repo: "Claxedo", channel: "latest" },
        rpm: { packageName: "claxedo" },
      }
    }
  }
}

export default getConfig()
