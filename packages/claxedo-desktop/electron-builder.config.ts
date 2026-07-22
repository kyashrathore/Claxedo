import type { Configuration } from "electron-builder"

const channel = (() => {
  const raw = process.env.CLAXEDO_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

// Node-style os-arch for the build TARGET, so we can drop every OTHER
// platform's native variant packages. A cross build (e.g. x64 on an arm64
// runner) resolves all-platform optionalDependencies into the store — without
// this, electron-builder's default node_modules sweep bundles all six
// @anthropic-ai/claude-agent-sdk-<platform> copies (~1.4GB) into the app.
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

// Every per-platform native variant suffix electron-builder might otherwise
// bundle. Exclude all but the target (and, for a glibc linux target, keep its
// musl sibling out too — the app ships one libc).
const ALL_PLATFORM_SUFFIXES = [
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
  "win32-x64",
  "win32-arm64",
]
const foreignPlatformExcludes = ALL_PLATFORM_SUFFIXES.filter((suffix) => suffix !== targetOsArch).map(
  (suffix) => `!**/node_modules/**/*-${suffix}/**`,
)

const getBase = (): Configuration => ({
  artifactName: "claxedo-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: [
    "out/**/*",
    "resources/**/*",
    "!**/node_modules/@claxedo/app/**",
    "!**/node_modules/@opencode-ai/ui/**",
    "!**/node_modules/@openai/codex/vendor",
    "!**/node_modules/@anthropic-ai/claude-agent-sdk/vendor",
    // The Claude native harness spawns the user's (or the sandbox image's)
    // installed `claude` via pathToClaudeCodeExecutable, so the SDK's ~230MB
    // per-platform native binary is never used at runtime — drop every variant
    // (target included) instead of shipping it dead in the app.
    "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
    ...foreignPlatformExcludes,
  ],
  asarUnpack: [
    "**/node_modules/better-sqlite3/**",
    "**/node_modules/node-pty/**",
  ],
  extraResources: [
    {
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    },
    {
      from: "resources/acp/",
      to: "acp/",
      filter: ["**/*"],
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
