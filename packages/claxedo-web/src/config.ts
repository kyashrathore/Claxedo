const clean = (value: string | undefined) => value?.trim().replace(/\/+$/, "")

export const appUrl =
  clean(import.meta.env.PUBLIC_CLAXEDO_APP_URL) ??
  clean(import.meta.env.CLAXEDO_APP_URL) ??
  (import.meta.env.DEV ? "http://localhost:4444" : "https://app.claxedo.com")

export const previewSrc = `${appUrl}/demo/?embed=1`

export const contact = "https://discord.gg/jSyhEQyT"
export const github = "https://github.com/kyashrathore/Claxedo"
export const docs = "https://docs.claxedo.com"

export const version = "0.0.59"

const dlBase = `${github}/releases/download/claxedo-v${version}`

export const downloads = [
  { label: "macOS (Apple Silicon)", href: `${dlBase}/Claxedo_${version}_aarch64.dmg` },
  { label: "macOS (Intel)", href: `${dlBase}/Claxedo_${version}_x64.dmg` },
  { label: "Windows", href: `${dlBase}/Claxedo_${version}_x64-setup.exe` },
  { label: "Linux (.deb)", href: `${dlBase}/Claxedo_${version}_amd64.deb` },
  { label: "Linux (.rpm)", href: `${dlBase}/Claxedo-${version}-1.x86_64.rpm` },
]
