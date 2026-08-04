import type { Configuration } from "electron-builder"

const channel = (() => {
  const raw = process.env.CLAXEDO_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

// Node-style os-arch for the build TARGET, so the native module set below
// can include platform-conditional entries (Windows-only process tree).
const targetOsArch = (() => {
  const map: Record<string, string> = {
    "aarch64-apple-darwin": "darwin-arm64",
    "x86_64-apple-darwin": "darwin-x64",
    "x86_64-pc-windows-msvc": "win32-x64",
    "x86_64-unknown-linux-gnu": "linux-x64",
    "aarch64-unknown-linux-gnu": "linux-arm64",
  }
  const rust = process.env.RUST_TARGET
  if (rust && map[rust]) return map[rust]
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  return `${process.platform}-${arch}`
})()
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
  // Chromium-internal UI strings (menus, permission prompts, error pages) in
  // the app's own languages; every other locale falls back to English. The
  // app's own translations live in the renderer bundle, not here.
  electronLanguages: [
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
    "bs",
  ],
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
  ],
  mac: {
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
    icon: "resources/icons",
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
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
