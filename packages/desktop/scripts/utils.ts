import { $ } from "bun"
import * as nodePath from "path"
import { existsSync, writeFileSync, unlinkSync } from "fs"

export const SIDECAR_BINARIES: Array<{ rustTarget: string; ocBinary: string; assetExt: string }> = [
  {
    rustTarget: "aarch64-apple-darwin",
    ocBinary: "opencode-darwin-arm64",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-apple-darwin",
    ocBinary: "opencode-darwin-x64-baseline",
    assetExt: "zip",
  },
  {
    rustTarget: "aarch64-pc-windows-msvc",
    ocBinary: "opencode-windows-arm64",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-pc-windows-msvc",
    ocBinary: "opencode-windows-x64-baseline",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-unknown-linux-gnu",
    ocBinary: "opencode-linux-x64-baseline",
    assetExt: "tar.gz",
  },
  {
    rustTarget: "aarch64-unknown-linux-gnu",
    ocBinary: "opencode-linux-arm64",
    assetExt: "tar.gz",
  },
]

export const RUST_TARGET = Bun.env.RUST_TARGET

export function getCurrentSidecar(target = RUST_TARGET) {
  if (!target && !RUST_TARGET) throw new Error("RUST_TARGET not set")

  const binaryConfig = SIDECAR_BINARIES.find((b) => b.rustTarget === target)
  if (!binaryConfig) throw new Error(`Sidecar configuration not available for Rust target '${RUST_TARGET}'`)

  return binaryConfig
}

export async function copyBinaryToSidecarFolder(source: string, target = RUST_TARGET) {
  await $`mkdir -p src-tauri/sidecars`
  const dest = windowsify(`src-tauri/sidecars/opencode-cli-${target}`)
  await $`cp ${source} ${dest}`

  console.log(`Copied ${source} to ${dest}`)
}

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path
  return `${path}${process.platform === "win32" ? ".exe" : ""}`
}

const RUST_TO_BUN_TARGET: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
}

export function rustTargetToBunTarget(rustTarget: string): string {
  const bunTarget = RUST_TO_BUN_TARGET[rustTarget]
  if (!bunTarget) throw new Error(`No bun compile target for Rust target '${rustTarget}'`)
  return bunTarget
}

export async function compilePortless(target = RUST_TARGET) {
  if (!target) throw new Error("RUST_TARGET not set")
  if (process.platform === "win32" || target.includes("windows")) {
    console.log(`Skipping portless compile for ${target} (portless is not published for Windows)`)
    return
  }

  const bunTarget = rustTargetToBunTarget(target)
  const outfile = windowsify(`src-tauri/sidecars/portless-${target}`)

  // Resolve the portless CLI path at build time.
  // We can't use `import "portless/dist/cli.js"` (exports field blocks it)
  // or a relative `../node_modules/portless/...` path (breaks on Windows CI
  // where symlinks may not work). Instead, resolve the main entry via Bun,
  // derive the CLI path, and generate a temp entry with an absolute import.
  //
  // Try multiple resolution roots because bun workspace hoisting varies by
  // platform — on Windows CI deps may only exist in the monorepo root.
  const resolveDirs = [
    nodePath.resolve(import.meta.dir, "../../claxedo-app"), // where portless is declared
    nodePath.resolve(import.meta.dir, ".."),                // packages/desktop
    nodePath.resolve(import.meta.dir, "../../.."),          // monorepo root
  ]
  let portlessMain: string | undefined
  for (const dir of resolveDirs) {
    try {
      portlessMain = Bun.resolveSync("portless", dir)
      break
    } catch {}
  }
  if (!portlessMain) {
    throw new Error(`Cannot find package 'portless' from any of: ${resolveDirs.join(", ")}`)
  }
  const portlessCli = nodePath.join(nodePath.dirname(portlessMain), "cli.js")
  if (!existsSync(portlessCli)) {
    throw new Error(`portless CLI not found at ${portlessCli}`)
  }

  const tmpEntry = nodePath.join(import.meta.dir, ".portless-compile-entry.tmp.ts")
  writeFileSync(
    tmpEntry,
    [
      "process.argv.splice(1, 0, process.execPath)",
      `import ${JSON.stringify(portlessCli)}`,
      "",
    ].join("\n"),
  )

  await $`mkdir -p src-tauri/sidecars`
  console.log(`Compiling portless for ${target} (${bunTarget})...`)
  try {
    await $`bun build --compile --target=${bunTarget} ${tmpEntry} --outfile ${outfile}`
  } finally {
    try { unlinkSync(tmpEntry) } catch {}
  }
  console.log(`Compiled portless to ${outfile}`)
}
