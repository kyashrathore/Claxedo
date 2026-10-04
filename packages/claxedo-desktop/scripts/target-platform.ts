const RUST_TARGETS: Record<string, string> = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "x86_64-pc-windows-msvc": "win32-x64",
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
}

export function resolveTargetOsArch() {
  const rust = process.env.RUST_TARGET
  if (rust && RUST_TARGETS[rust]) return RUST_TARGETS[rust]
  const arch = (process.env.npm_config_arch ?? process.arch) === "arm64" ? "arm64" : "x64"
  return `${process.platform}-${arch}`
}
