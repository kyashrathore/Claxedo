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

export const downloads = [
  { platform: "macos-arm64", label: "macOS (Apple Silicon)", format: ".dmg", href: `${dlBase}/Claxedo_${version}_aarch64.dmg` },
  { platform: "macos-x64", label: "macOS (Intel)", format: ".dmg", href: `${dlBase}/Claxedo_${version}_x64.dmg` },
  { platform: "windows-x64", label: "Windows", format: ".exe", href: `${dlBase}/Claxedo_${version}_x64-setup.exe` },
  { platform: "linux-deb", label: "Linux (.deb)", format: ".deb", href: `${dlBase}/Claxedo_${version}_amd64.deb` },
  { platform: "linux-rpm", label: "Linux (.rpm)", format: ".rpm", href: `${dlBase}/Claxedo-${version}-1.x86_64.rpm` },
]
