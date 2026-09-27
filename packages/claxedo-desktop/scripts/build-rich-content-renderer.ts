import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { chmod } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { richContentRendererBinaryName } from "../src/main/rich-content-renderer-path"
import { resolveTargetOsArch } from "./target-platform"

function rendererOutput() {
  const target = resolveTargetOsArch()
  const binary = richContentRendererBinaryName(target.split("-")[0])
  return resolve(import.meta.dirname, `../resources/rich-content/${target}/${binary}`)
}

/**
 * The desktop draws Mermaid only through this helper, so a source build or dev
 * session without it shows each diagram as its code block. Release packaging
 * opts into a required Cargo build explicitly; contributors can do the same
 * with CLAXEDO_BUILD_NATIVE_RICH_CONTENT=1.
 */
export async function prepareRichContentRenderer(options: { required?: boolean } = {}) {
  const output = rendererOutput()
  const shouldBuild = options.required || process.env.CLAXEDO_BUILD_NATIVE_RICH_CONTENT === "1"
  if (shouldBuild) return buildRichContentRenderer()
  if (existsSync(output)) return output
  console.warn("[rich-content] native helper unavailable; desktop shows Mermaid diagrams as code")
  return undefined
}

export async function buildRichContentRenderer() {
  const crate = resolve(import.meta.dirname, "../native/rich-content-renderer")
  const rustTarget = process.env.RUST_TARGET
  const args = ["cargo", "build", "--release", "--locked", ...(rustTarget ? ["--target", rustTarget] : [])]
  const result = Bun.spawnSync({ cmd: args, cwd: crate, stdout: "inherit", stderr: "inherit" })
  if (result.exitCode !== 0) throw new Error(`rich-content renderer build failed with exit code ${result.exitCode}`)

  const binary = richContentRendererBinaryName(resolveTargetOsArch().split("-")[0])
  const targetDirectory = process.env.CARGO_TARGET_DIR ? resolve(crate, process.env.CARGO_TARGET_DIR) : join(crate, "target")
  const source = join(targetDirectory, ...(rustTarget ? [rustTarget] : []), "release", binary)
  const output = rendererOutput()
  mkdirSync(dirname(output), { recursive: true })
  copyFileSync(source, output)
  if (!output.endsWith(".exe")) await chmod(output, 0o755)
  return output
}

if (import.meta.main) {
  console.log(`[rich-content] ${await buildRichContentRenderer()}`)
}
