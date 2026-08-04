const clean = (value: string | undefined) => value?.trim().replace(/\/+$/, "")

export const appUrl =
  clean(import.meta.env.PUBLIC_CLAXEDO_APP_URL) ??
  clean(import.meta.env.CLAXEDO_APP_URL) ??
  (import.meta.env.DEV ? "http://localhost:4444" : "https://app.claxedo.com")

export const previewSrc = `${appUrl}/demo/?embed=1`

export const contact = "https://discord.gg/GC6QagQ8QE"
export const github = "https://github.com/kyashrathore/Claxedo"
export const docs = "/framework"
export const version = "0.0.64"

const dlBase = `${github}/releases/download/claxedo-v${version}`

// Filenames come from electron-builder's
// `artifactName: "claxedo-desktop-${os}-${arch}.${ext}"`
// (packages/claxedo-desktop/electron-builder.config.ts) — keep this list in
// sync with it, and with release-claxedo.yml's five build legs. A drifted name
// 404s the download silently. (Releases ≤0.0.59 were Tauri-built with a
// different naming scheme; those links are gone from this page on purpose.)
export const downloads = [
  { platform: "macos-arm64", label: "macOS (Apple Silicon)", format: ".dmg", href: `${dlBase}/claxedo-desktop-mac-arm64.dmg` },
  { platform: "macos-x64", label: "macOS (Intel)", format: ".dmg", href: `${dlBase}/claxedo-desktop-mac-x64.dmg` },
  { platform: "windows-x64", label: "Windows", format: ".exe", href: `${dlBase}/claxedo-desktop-win-x64.exe` },
  { platform: "linux-appimage", label: "Linux (AppImage)", format: ".AppImage", href: `${dlBase}/claxedo-desktop-linux-x64.AppImage` },
  { platform: "linux-deb", label: "Linux (.deb)", format: ".deb", href: `${dlBase}/claxedo-desktop-linux-x64.deb` },
  { platform: "linux-rpm", label: "Linux (.rpm)", format: ".rpm", href: `${dlBase}/claxedo-desktop-linux-x64.rpm` },
  { platform: "linux-arm64-appimage", label: "Linux ARM64 (AppImage)", format: ".AppImage", href: `${dlBase}/claxedo-desktop-linux-arm64.AppImage` },
  { platform: "linux-arm64-deb", label: "Linux ARM64 (.deb)", format: ".deb", href: `${dlBase}/claxedo-desktop-linux-arm64.deb` },
  { platform: "linux-arm64-rpm", label: "Linux ARM64 (.rpm)", format: ".rpm", href: `${dlBase}/claxedo-desktop-linux-arm64.rpm` },
]
