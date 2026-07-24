const targets = {
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    bun: "bun-darwin-arm64",
  },
  "darwin-x64": {
    triple: "x86_64-apple-darwin",
    bun: "bun-darwin-x64-baseline",
  },
  "linux-arm64": {
    triple: "aarch64-unknown-linux-musl",
    bun: "bun-linux-arm64",
  },
  "linux-x64": {
    triple: "x86_64-unknown-linux-musl",
    bun: "bun-linux-x64-baseline",
  },
  "win32-arm64": {
    triple: "aarch64-pc-windows-msvc",
    bun: "bun-windows-arm64",
  },
  "win32-x64": {
    triple: "x86_64-pc-windows-msvc",
    bun: "bun-windows-x64-baseline",
  },
} as const

export function codexAcpTarget(platform: string, arch: string) {
  const target = targets[`${platform}-${arch}` as keyof typeof targets]
  if (target) return target
  throw new Error(`Unsupported Codex ACP target: ${platform}/${arch}`)
}
