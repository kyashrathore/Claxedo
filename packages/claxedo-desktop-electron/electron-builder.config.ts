import type { Configuration } from "electron-builder"

const channel = (() => {
  const raw = process.env.CLAXEDO_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const getBase = (): Configuration => ({
  artifactName: "claxedo-electron-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: [
    "out/**/*",
    "resources/**/*",
    "!**/node_modules/@opencode-ai/**",
    "!**/node_modules/@openai/codex/vendor",
    "!**/node_modules/@anthropic-ai/claude-agent-sdk/vendor",
  ],
  extraResources: [
    {
      from: "resources/",
      to: "",
      filter: ["opencode-cli*", "claxedo-mcp.js"],
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
