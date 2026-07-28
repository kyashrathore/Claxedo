const clean = (value: string | undefined) => value?.trim().replace(/\/+$/, "")

export const appUrl =
  clean(import.meta.env.PUBLIC_CLAXEDO_APP_URL) ??
  clean(import.meta.env.CLAXEDO_APP_URL) ??
  (import.meta.env.DEV ? "http://localhost:4444" : "https://app.claxedo.com")

export const previewSrc = `${appUrl}/demo/?embed=1`

export const contact = "https://discord.gg/GC6QagQ8QE"
export const github = "https://github.com/kyashrathore/Claxedo"
export const docs = "/framework"
export const version = "0.0.59"

const dlBase = `${github}/releases/download/claxedo-v${version}`

// v0.0.59 is the last release built by the retired Tauri pipeline, whose
// bundler emitted these exact per-platform filenames (verified against the
// live claxedo-v0.0.59 release assets). Every release after it is produced by
// electron-builder (packages/claxedo-desktop/electron-builder.config.ts),
// whose `artifactName: "claxedo-desktop-${os}-${arch}.${ext}"` emits a
// completely different naming scheme. Bumping `version` past 0.0.59 while
// still using the Tauri names below would 404 every download link — keep
// this branch in sync with electron-builder.config.ts's artifactName.
const LAST_TAURI_VERSION = "0.0.59"

export const downloads =
  version === LAST_TAURI_VERSION
    ? [
        { platform: "macos-arm64", label: "macOS (Apple Silicon)", format: ".dmg", href: `${dlBase}/Claxedo_${version}_aarch64.dmg` },
        { platform: "macos-x64", label: "macOS (Intel)", format: ".dmg", href: `${dlBase}/Claxedo_${version}_x64.dmg` },
        { platform: "windows-x64", label: "Windows", format: ".exe", href: `${dlBase}/Claxedo_${version}_x64-setup.exe` },
        { platform: "linux-deb", label: "Linux (.deb)", format: ".deb", href: `${dlBase}/Claxedo_${version}_amd64.deb` },
        { platform: "linux-rpm", label: "Linux (.rpm)", format: ".rpm", href: `${dlBase}/Claxedo-${version}-1.x86_64.rpm` },
      ]
    : [
        { platform: "macos-arm64", label: "macOS (Apple Silicon)", format: ".dmg", href: `${dlBase}/claxedo-desktop-mac-arm64.dmg` },
        { platform: "macos-x64", label: "macOS (Intel)", format: ".dmg", href: `${dlBase}/claxedo-desktop-mac-x64.dmg` },
        { platform: "windows-x64", label: "Windows", format: ".exe", href: `${dlBase}/claxedo-desktop-win-x64.exe` },
        { platform: "linux-deb", label: "Linux (.deb)", format: ".deb", href: `${dlBase}/claxedo-desktop-linux-x64.deb` },
        { platform: "linux-rpm", label: "Linux (.rpm)", format: ".rpm", href: `${dlBase}/claxedo-desktop-linux-x64.rpm` },
      ]
