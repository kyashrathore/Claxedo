import { copyFileSync, mkdirSync } from "node:fs"
import { chmod } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { richContentRendererBinaryName } from "../src/main/rich-content-renderer-path"
import { resolveTargetOsArch } from "./target-platform"

export async function buildRichContentRenderer() {
  const crate = resolve(import.meta.dirname, "../native/rich-content-renderer")
  const rustTarget = process.env.RUST_TARGET
  const args = ["cargo", "build", "--release", "--locked", ...(rustTarget ? ["--target", rustTarget] : [])]
  const result = Bun.spawnSync({ cmd: args, cwd: crate, stdout: "inherit", stderr: "inherit" })
  if (result.exitCode !== 0) throw new Error(`rich-content renderer build failed with exit code ${result.exitCode}`)

  const binary = richContentRendererBinaryName(resolveTargetOsArch().split("-")[0])
  const targetDirectory = process.env.CARGO_TARGET_DIR ? resolve(crate, process.env.CARGO_TARGET_DIR) : join(crate, "target")
  const source = join(targetDirectory, ...(rustTarget ? [rustTarget] : []), "release", binary)
  const output = resolve(import.meta.dirname, `../resources/rich-content/${resolveTargetOsArch()}/${binary}`)
  mkdirSync(dirname(output), { recursive: true })
  copyFileSync(source, output)
  if (!output.endsWith(".exe")) await chmod(output, 0o755)
  return output
}

if (import.meta.main) {
  console.log(`[rich-content] ${await buildRichContentRenderer()}`)
}
